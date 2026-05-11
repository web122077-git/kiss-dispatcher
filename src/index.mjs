#!/usr/bin/env node
// kiss-dispatcher — KISS PG-advisory-lock dispatcher with multi-turn tool loop.
//
// Architecture: per spike findings + Phase 2 T2a tool-call loop +
// decision-tools-per-role-not-batch-2026-05-11.

import pg from "pg";
import { chatWithTools } from "./ollama.mjs";
import { toolsForRole } from "./tools.mjs";
import { PROMPT_BUILDERS, parseOutput } from "./prompts.mjs";
import { runTest } from "./test-runner.mjs";

const PG_URL     = process.env.PG_URL     || "postgresql://postgres:kiss-spike-pw@10.98.98.34:5434/dispatcher";
const CTX_API    = (process.env.CTX_API   || "http://10.77.77.2:3001").replace(/\/$/, "");
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://10.50.50.11:11434").replace(/\/$/, "");
const MODEL      = process.env.MODEL      || "qwen3-coder:30b";
const WORKER_ID  = process.env.WORKER_ID  || `kiss-worker-${process.pid}`;
const ROLE_HINT  = process.env.ROLE_HINT  || "pm";
const WORKER_ASSIGNEE_ID = process.env.WORKER_ASSIGNEE_ID || `${process.env.HOMELAB_ENV || "zdev"}-${ROLE_HINT}`;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);
const NUM_PREDICT = parseInt(process.env.NUM_PREDICT || (
  // Provisional defaults per T2h. Override per worker as needed.
  { cpm: 400, pm: 600, tl: 800, be: 4000, fe: 4000, do: 3000, qa: 600, doc: 2000, closer: 800 }[ROLE_HINT] || 600
), 10);

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });

function log(level, msg, extra) {
  console.log(JSON.stringify({ t: new Date().toISOString(), worker: WORKER_ID, level, msg, ...(extra || {}) }));
}

// ── Claim & lifecycle helpers (unchanged from spike's two-phase-write version) ──

// T3: claim via server-side endpoint (atomic CAS + worker_assignee_id filter).
// Replaces the spike-era list-then-PATCH pattern. Server's POST /agile/task/claim
// already implements assignee_id filtering, role_hint allowlist, model allowlist,
// and the (:Worker)-[:WORKING_ON]->(:Task) edge for heartbeat-aware eviction.
async function claimFromServer() {
  const r = await fetch(`${CTX_API}/agile/task/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      worker_id: WORKER_ID,
      worker_assignee_id: WORKER_ASSIGNEE_ID,
      role_allowlist: [ROLE_HINT],
      model_allowlist: [],  // wildcard — we don't second-guess Task.model_override
    }),
  });
  if (r.status === 204) return null;   // nothing claimable
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`claim HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const t = await r.json();
  // Server returns the bare claimed Task; fetch full props for the handlers.
  const fullR = await fetch(`${CTX_API}/agile/task/${encodeURIComponent(t.id)}`);
  if (!fullR.ok) throw new Error(`post-claim GET HTTP ${fullR.status}`);
  return await fullR.json();
}

async function ensureWorkerNode() {
  // Server-side /agile/task/claim Cypher does MATCH (w:Worker { id: $worker_id })
  // which fails silently if the node doesn't exist — caller sees 204. We MERGE
  // the Worker node on boot so claim succeeds idempotently.
  const r = await fetch(`${CTX_API}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `MERGE (w:Worker { id: $id })
              ON CREATE SET w.created_at = datetime(), w.role_hint = $role,
                            w.assignee_id = $aid
              ON MATCH  SET w.last_seen_at = datetime()
              RETURN w.id AS id`,
      params: { id: WORKER_ID, role: ROLE_HINT, aid: WORKER_ASSIGNEE_ID },
    }),
  });
  if (!r.ok) throw new Error(`ensureWorkerNode HTTP ${r.status}`);
  return await r.json();
}

async function getTaskStatus(taskId) {
  const r = await fetch(`${CTX_API}/agile/task/${encodeURIComponent(taskId)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.status;
}

async function patchTask(taskId, body) {
  const r = await fetch(`${CTX_API}/agile/task/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await r.text() };
}

// T3: server-side CAS handled the claim. Local bookkeeping records the run.
async function recordRunStart(task) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO dispatcher_runs (task_id, role_hint, worker_id, status)
       VALUES ($1,$2,$3,'doing')
       ON CONFLICT (task_id) DO UPDATE
         SET worker_id=$3, claimed_at=now(), status='doing', result=NULL, finished_at=NULL,
             redispatch_count=dispatcher_runs.redispatch_count+1`,
      [task.id, task.role_hint, WORKER_ID]);
  } catch (e) {
    log("warn", "recordRunStart_failed", { taskId: task.id, err: e.message });
  } finally { client.release(); }
}

async function ensureTestOutputCol() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE dispatcher_runs ADD COLUMN IF NOT EXISTS test_output jsonb`);
  } catch (e) { /* table may not exist yet; non-fatal */ }
  finally { client.release(); }
}

async function finishRun(taskId, status, result, extra = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const setTestOutput = extra && extra.test_output !== undefined ? ", test_output=$4" : "";
    const params = [taskId, status, (result || "").slice(0, 4096)];
    if (extra && extra.test_output !== undefined) params.push(JSON.stringify(extra.test_output).slice(0, 32768));
    await client.query(
      `UPDATE dispatcher_runs SET status=$2, result=$3, finished_at=now()${setTestOutput} WHERE task_id=$1`,
      params);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log("error", "finishRun_failed", { taskId, err: e.message });
  } finally { client.release(); }
}

// ── T2d: PM↔CPM convergence cap ───────────────────────────────────────────
// Per decision-pm-cpm-convergence-cap-2026-05-11 (filed when this lands).
// PG-backed counter: cap=3 pushbacks per Epic before escalation to CLOSER.

const PM_PUSHBACK_CAP = parseInt(process.env.PM_PUSHBACK_CAP || "3", 10);

async function ensurePushbackSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pm_pushbacks (
        id              bigserial PRIMARY KEY,
        epic_id         text NOT NULL,
        pm_task_id      text NOT NULL,
        next_task_id    text,
        cap_hit         boolean NOT NULL DEFAULT false,
        concrete_change text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS pm_pushbacks_epic_idx ON pm_pushbacks(epic_id)`);
  } finally { client.release(); }
}

function envPrefixFor(role) {
  // zdev workers route pushbacks to zdev counterparts; prod to prod.
  // WORKER_ID convention: zdev-* or prod-* prefix.
  const env = (WORKER_ID.startsWith("zdev-") || ROLE_HINT.startsWith("zdev-")) ? "zdev" : "prod";
  return `${env}-${role}`;
}

async function recordPushbackAndCount(epicId, pmTaskId, concreteChange) {
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO pm_pushbacks (epic_id, pm_task_id, concrete_change) VALUES ($1,$2,$3)`,
      [epicId, pmTaskId, concreteChange]);
    const cR = await client.query(`SELECT COUNT(*)::int AS c FROM pm_pushbacks WHERE epic_id=$1`, [epicId]);
    return cR.rows[0].c;
  } finally { client.release(); }
}

async function setPushbackNextTaskId(pmTaskId, nextTaskId, capHit) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE pm_pushbacks SET next_task_id=$2, cap_hit=$3 WHERE pm_task_id=$1
                        AND id = (SELECT MAX(id) FROM pm_pushbacks WHERE pm_task_id=$1)`,
      [pmTaskId, nextTaskId, capHit]);
  } finally { client.release(); }
}

async function handlePmPushback(task, parsed) {
  const epicId = parsed.parsed?.epic_id || parsed.epic_id;
  const concreteChange = parsed.parsed?.concrete_change || parsed.concrete_change;
  const reason = parsed.parsed?.reason || parsed.reason || "(none)";
  if (!epicId || !concreteChange) {
    return { ok: false, error: "pm_pushback missing epic_id or concrete_change" };
  }
  const count = await recordPushbackAndCount(epicId, task.id, concreteChange);
  const capHit = count >= PM_PUSHBACK_CAP;
  const newRole = capHit ? "closer" : "cpm";
  const newId = `pm-pushback-${task.id}-${count}`;

  const description = capHit
    ? `PM has pushed back ${count} times on Epic ${epicId}. Per-Epic cap (${PM_PUSHBACK_CAP}) is exceeded.

Latest concrete_change from PM:
${concreteChange}

Reason:
${reason}

Write a Decision: either (a) accept PM's concrete_change and update the Epic framing once, or (b) halt the Epic with a Decision capturing why the framing stands. Do NOT route this back to PM — the loop must stop here.`
    : `PM cannot decompose Epic ${epicId} as currently framed (pushback ${count}/${PM_PUSHBACK_CAP}).

Concrete change requested:
${concreteChange}

Full reason:
${reason}

Review the Epic and either: (a) restate the framing addressing concrete_change, OR (b) close the Epic with a Decision explaining why the original framing stands.`;

  const newTask = {
    id: newId,
    title: capHit
      ? `CLOSER: PM↔CPM pushback cap on epic ${epicId}`
      : `CPM: Address PM pushback ${count}/${PM_PUSHBACK_CAP} on epic ${epicId}`,
    description,
    acceptance_criteria: capHit
      ? "A Decision is filed on this Epic with status accepted or proposed; the PM-Task chain is halted."
      : "The Epic framing is updated to address concrete_change, OR a Decision is filed explaining why the original framing stands.",
    role_hint: newRole,
    assignee_id: envPrefixFor(newRole),
    parent_id: task.parent_id,
    tags: ["pm-pushback", capHit ? "cap-hit" : "below-cap"],
  };

  const r = await fetch(`${CTX_API}/agile/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newTask),
  });
  if (!r.ok) {
    const body = await r.text();
    return { ok: false, error: `agile/task POST failed ${r.status}: ${body.slice(0,200)}` };
  }
  await setPushbackNextTaskId(task.id, newId, capHit);
  return { ok: true, count, capHit, newId, newRole };
}

// ── T2f: QA verdict enforcement (red-flag halt + revise-loop cap) ────────
// Per decision-qa-redflag-enforcement-2026-05-11 (filed when this lands).
// Counter is keyed on story_id (the parent Story of the QA Task). Red-flag
// always escalates to CLOSER regardless of revise count.

const QA_REVISE_CAP = parseInt(process.env.QA_REVISE_CAP || "3", 10);

async function ensureQaSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS qa_verdicts (
        id                  bigserial PRIMARY KEY,
        qa_task_id          text NOT NULL,
        story_id            text,
        submission_task_id  text,
        verdict             text NOT NULL,
        red_flag            text,
        next_task_id        text,
        cap_hit             boolean NOT NULL DEFAULT false,
        created_at          timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS qa_verdicts_story_idx ON qa_verdicts(story_id)`);
  } finally { client.release(); }
}

async function recordQaAndCount(storyId, qaTaskId, submissionTaskId, verdict, redFlag) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO qa_verdicts (qa_task_id, story_id, submission_task_id, verdict, red_flag)
       VALUES ($1,$2,$3,$4,$5)`,
      [qaTaskId, storyId, submissionTaskId, verdict, redFlag]);
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM qa_verdicts WHERE story_id=$1 AND verdict='revise' AND (red_flag IS NULL)`,
      [storyId]);
    return r.rows[0].c;
  } finally { client.release(); }
}

async function setQaNextTaskId(qaTaskId, nextTaskId, capHit) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE qa_verdicts SET next_task_id=$2, cap_hit=$3 WHERE qa_task_id=$1
       AND id=(SELECT MAX(id) FROM qa_verdicts WHERE qa_task_id=$1)`,
      [qaTaskId, nextTaskId, capHit]);
  } finally { client.release(); }
}

async function handleQaVerdict(task, parsed) {
  const p = parsed.parsed || {};
  const verdict = p.verdict;
  const redFlag = p.red_flag || null;
  const defects = Array.isArray(p.defects) ? p.defects : [];
  const notes = p.notes || "";
  const storyId = task.parent_id || null;
  const submissionTaskId = task.metadata?.submission_task_id || null;
  const submissionRole = task.metadata?.submission_role_hint || "be";

  if (!verdict) return { ok: false, error: "qa_verdict missing verdict" };

  // Approve = no new Task; tag the submission Task if known.
  if (verdict === "approve" && !redFlag) {
    await recordQaAndCount(storyId, task.id, submissionTaskId, verdict, null);
    if (submissionTaskId) {
      try {
        await fetch(`${CTX_API}/agile/task/${encodeURIComponent(submissionTaskId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: ["qa-approved"] }),
        });
      } catch (e) { /* non-fatal */ }
    }
    return { ok: true, verdict, newId: null, capHit: false, action: "approved-no-new-task" };
  }

  // Red-flag = always escalate to CLOSER (show-stopper).
  if (redFlag) {
    await recordQaAndCount(storyId, task.id, submissionTaskId, verdict, redFlag);
    const newId = `qa-redflag-${task.id}-${Date.now()}`;
    const description =
      `QA tripped red_flag="${redFlag}" reviewing submission on story ${storyId}.\n\n` +
      `Verdict: ${verdict}\nDefects: ${JSON.stringify(defects)}\nNotes: ${notes}\n\n` +
      `Red-flag is a show-stopper. Do NOT route back to the submitter. Write a Decision: ` +
      `either (a) update the Lesson that named this red_flag if the trade-off is acceptable here, ` +
      `or (b) close the Story with a Decision capturing why the work cannot proceed.`;
    const newTask = {
      id: newId,
      title: `CLOSER: QA red_flag "${redFlag}" on story ${storyId}`,
      description,
      acceptance_criteria: "A Decision is filed on the parent Story or its Epic; the QA-submitter chain is halted.",
      role_hint: "closer",
      assignee_id: envPrefixFor("closer"),
      parent_id: storyId,
      tags: ["qa-redflag", "halt"],
    };
    const r = await fetch(`${CTX_API}/agile/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newTask),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `redflag CLOSER POST failed ${r.status}: ${body.slice(0,200)}` };
    }
    await setQaNextTaskId(task.id, newId, true);
    return { ok: true, verdict, redFlag, newId, capHit: true, action: "closer-redflag-halt" };
  }

  // reject = CLOSER halt
  if (verdict === "reject") {
    await recordQaAndCount(storyId, task.id, submissionTaskId, verdict, null);
    const newId = `qa-reject-${task.id}-${Date.now()}`;
    const description =
      `QA returned verdict=reject (core premise unsalvageable).\n` +
      `Defects: ${JSON.stringify(defects)}\nNotes: ${notes}\n\n` +
      `Write a Decision: either (a) refine the Story or break it into smaller Stories before re-attempting, ` +
      `or (b) close the Story with a Decision capturing why the work cannot proceed as defined.`;
    const newTask = {
      id: newId,
      title: `CLOSER: QA rejected submission on story ${storyId}`,
      description,
      acceptance_criteria: "A Decision is filed on the parent Story; the QA-submitter chain is halted.",
      role_hint: "closer",
      assignee_id: envPrefixFor("closer"),
      parent_id: storyId,
      tags: ["qa-reject", "halt"],
    };
    const r = await fetch(`${CTX_API}/agile/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newTask),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `reject CLOSER POST failed ${r.status}: ${body.slice(0,200)}` };
    }
    await setQaNextTaskId(task.id, newId, true);
    return { ok: true, verdict, newId, capHit: true, action: "closer-reject-halt" };
  }

  // needs_evidence = re-brief submitter for evidence
  if (verdict === "needs_evidence") {
    await recordQaAndCount(storyId, task.id, submissionTaskId, verdict, null);
    const newId = `qa-needs-evidence-${task.id}-${Date.now()}`;
    const description =
      `QA could not approve because evidence was missing.\nNotes: ${notes}\n\n` +
      `Provide the evidence QA asked for and resubmit. Cite specific lines or graph nodes you read — fabrication is a halt.`;
    const newTask = {
      id: newId,
      title: `${submissionRole.toUpperCase()}: provide evidence (QA needs_evidence)`,
      description,
      acceptance_criteria: "Resubmit with concrete evidence citations (file:line or graph-node-id you actually inspected).",
      role_hint: submissionRole,
      assignee_id: envPrefixFor(submissionRole),
      parent_id: storyId,
      tags: ["qa-needs-evidence"],
    };
    const r = await fetch(`${CTX_API}/agile/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newTask),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `needs_evidence POST failed ${r.status}: ${body.slice(0,200)}` };
    }
    await setQaNextTaskId(task.id, newId, false);
    return { ok: true, verdict, newId, capHit: false, action: "rebrief-evidence" };
  }

  // revise = re-brief or cap
  if (verdict === "revise") {
    const count = await recordQaAndCount(storyId, task.id, submissionTaskId, verdict, null);
    const capHit = count >= QA_REVISE_CAP;
    const newRole = capHit ? "closer" : submissionRole;
    const newId = `qa-revise-${task.id}-${count}`;
    const defectLines = defects.map((d, i) => `  ${i + 1}. ${d}`).join("\n");
    const description = capHit
      ? `QA has issued ${count} revise verdicts on story ${storyId}. Per-Story cap (${QA_REVISE_CAP}) is exceeded.\n` +
        `Latest defects: ${JSON.stringify(defects)}\nLatest notes: ${notes}\n\n` +
        `Write a Decision: either accept the latest submission with the listed defects documented as known issues, ` +
        `or close the Story with a Decision capturing why convergence cannot be reached.`
      : `QA requests revision (${count}/${QA_REVISE_CAP}).\nDefects to address (max 2 per QA's policy):\n${defectLines}\n\n` +
        `Notes from QA: ${notes}\n\nResubmit addressing all listed defects. Do not introduce unrelated changes.`;
    const newTask = {
      id: newId,
      title: capHit
        ? `CLOSER: QA revise-loop cap on story ${storyId}`
        : `${submissionRole.toUpperCase()}: revise per QA (${count}/${QA_REVISE_CAP})`,
      description,
      acceptance_criteria: capHit
        ? "A Decision is filed on the parent Story; the revise loop is halted."
        : "Resubmit addressing the listed defects without introducing scope creep.",
      role_hint: newRole,
      assignee_id: envPrefixFor(newRole),
      parent_id: storyId,
      tags: capHit ? ["qa-revise", "cap-hit", "halt"] : ["qa-revise"],
    };
    const r = await fetch(`${CTX_API}/agile/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newTask),
    });
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `revise POST failed ${r.status}: ${body.slice(0,200)}` };
    }
    await setQaNextTaskId(task.id, newId, capHit);
    return { ok: true, verdict, count, newId, capHit, action: capHit ? "closer-revise-cap" : "rebrief-submitter" };
  }

  return { ok: false, error: `unknown verdict: ${verdict}` };
}

// ── Persona system prompts (loaded from personas.v7.json) ──────────────────

let PERSONAS = null;
async function loadPersonas() {
  if (PERSONAS) return PERSONAS;
  const fs = await import("node:fs/promises");
  const personasPath = process.env.PERSONAS_PATH || "/10310L/repos/persona-config/personas.v7.json";
  const text = await fs.readFile(personasPath, "utf8");
  const j = JSON.parse(text);
  PERSONAS = {};
  for (const p of j.personas) PERSONAS[p.id] = p;
  return PERSONAS;
}

// ── Build the user prompt per role ──────────────────────────────────────────

function buildUserPrompt(task, persona, hints = {}) {
  const builder = PROMPT_BUILDERS[ROLE_HINT];
  if (!builder) throw new Error(`no prompt builder for role_hint=${ROLE_HINT}`);
  return builder(task, persona, hints);
}

// ── Executor — uses the tool loop ──────────────────────────────────────────

async function executeOne(task) {
  // task is already claimed (status=doing) by the server before we got here.
  await recordRunStart(task);

  try {
    const personas = await loadPersonas();
    const persona = personas[ROLE_HINT];
    if (!persona) throw new Error(`no persona for role_hint=${ROLE_HINT}`);

    const tools = toolsForRole(ROLE_HINT);
    const messages = [
      { role: "system", content: persona.system_prompt },
      { role: "user",   content: buildUserPrompt(task, persona) },
    ];

    // status=doing was set atomically by server's claim — no PATCH needed here.

    const chat = await chatWithTools({
      ollamaUrl: OLLAMA_URL,
      model: MODEL,
      messages,
      tools,
      options: {
        temperature: persona.temperature ?? 0.2,
        top_p:       persona.top_p       ?? 0.85,
        num_predict: NUM_PREDICT,
      },
      log,
    });

    const summary = (chat.finalText || "").trim();
    if (!summary || summary.length < 10) {
      throw new Error(chat.cap_hit ? "tool_loop_cap_hit_no_final_text" : "model reply too short");
    }
    const parsed = parseOutput(ROLE_HINT, summary);
    if (!parsed.ok) {
      log("warn", "output_parse_failed", { taskId: task.id, err: parsed.error, preview: parsed.preview });
      // Don't fail the Task on parse fail in T2b — capture parse error in resolution + finishRun
      // so we can iterate on prompt templates without losing the model's text.
    } else {
      log("info", "output_parsed", { taskId: task.id, shape: parsed.shape, has_diff: !!parsed.diff });
    }

    // T2g: test-runner — apply diff + run test_command for BE/FE/DO submissions
    let testRunOutcome = null;
    if (parsed.ok && parsed.diff && ["be_implementation","fe_implementation","do_runbook","be","fe","do"].includes(parsed.shape || "")) {
      const targetRepo = parsed.parsed?.target_repo;
      const testCommand = parsed.parsed?.test_command;
      if (targetRepo && testCommand) {
        log("info", "test_runner_start", { taskId: task.id, targetRepo, testCommand });
        try {
          testRunOutcome = await runTest({
            targetRepo, diff: parsed.diff, testCommand,
            timeoutMs: 300_000, log,
          });
          log("info", "test_runner_done", {
            taskId: task.id,
            run_status: testRunOutcome.run_status,
            exit_code: testRunOutcome.exit_code,
            runtime_seconds: testRunOutcome.runtime_seconds,
          });
        } catch (e) {
          log("error", "test_runner_threw", { taskId: task.id, err: e.message });
          testRunOutcome = { run_status: "internal_error", stderr: e.message };
        }
      } else {
        log("info", "test_runner_skipped_no_metadata", { taskId: task.id });
      }
    }

    // T2d: PM pushback interception
    if (parsed.ok && parsed.shape === "pm_pushback" && ROLE_HINT === "pm") {
      const pb = await handlePmPushback(task, parsed);
      log("info", "pm_pushback_handled", { taskId: task.id, ...pb });
      if (!pb.ok) {
        await finishRun(task.id, "failed", `pm_pushback handler error: ${pb.error}`);
        await patchTask(task.id, {
          status: "done",
          resolution: `[kiss-dispatcher ${WORKER_ID} model=${MODEL} role=pm pm_pushback ERROR=${pb.error}]`,
        });
        return { ok: false, taskId: task.id, error: pb.error };
      }
      const setDonePb = await patchTask(task.id, {
        status: "done",
        resolution: `[kiss-dispatcher ${WORKER_ID} model=${MODEL} role=pm pm_pushback count=${pb.count}/${PM_PUSHBACK_CAP} cap_hit=${pb.capHit} next=${pb.newId}] ${parsed.parsed?.concrete_change?.slice(0, 320) || ""}`,
      });
      if (!setDonePb.ok) throw new Error(`patch done (pushback) failed: ${setDonePb.status}`);
      await finishRun(task.id, "done", `pm_pushback count=${pb.count} cap_hit=${pb.capHit} next=${pb.newId}`);
      return { ok: true, taskId: task.id, iterations: chat.iterations, tool_calls: chat.toolCallsMade.length, pm_pushback: pb };
    }

    // T2f: QA verdict interception (red-flag halt + revise-loop cap)
    if (parsed.ok && parsed.shape === "qa_verdict" && ROLE_HINT === "qa") {
      const qv = await handleQaVerdict(task, parsed);
      log("info", "qa_verdict_handled", { taskId: task.id, ...qv });
      if (!qv.ok) {
        await finishRun(task.id, "failed", `qa_verdict handler error: ${qv.error}`);
        await patchTask(task.id, {
          status: "done",
          resolution: `[kiss-dispatcher ${WORKER_ID} model=${MODEL} role=qa qa_verdict ERROR=${qv.error}]`,
        });
        return { ok: false, taskId: task.id, error: qv.error };
      }
      const verdictTag = qv.verdict + (qv.redFlag ? ` red_flag=${qv.redFlag}` : "");
      const setDoneQv = await patchTask(task.id, {
        status: "done",
        resolution: `[kiss-dispatcher ${WORKER_ID} model=${MODEL} role=qa ${verdictTag} action=${qv.action} next=${qv.newId || "none"} cap_hit=${qv.capHit}]`,
      });
      if (!setDoneQv.ok) throw new Error(`patch done (qa) failed: ${setDoneQv.status}`);
      await finishRun(task.id, "done", `qa_verdict=${qv.verdict} action=${qv.action} cap_hit=${qv.capHit}`);
      return { ok: true, taskId: task.id, iterations: chat.iterations, tool_calls: chat.toolCallsMade.length, qa_verdict: qv };
    }

    const setDone = await patchTask(task.id, {
      status: "done",
      resolution: `[kiss-dispatcher ${WORKER_ID} model=${MODEL} role=${ROLE_HINT} tool_calls=${chat.toolCallsMade.length}] ${summary.slice(0, 480)}`,
    });
    if (!setDone.ok) throw new Error(`patch done failed: ${setDone.status} ${setDone.body.slice(0,160)}`);

    await finishRun(task.id, "done", summary, testRunOutcome ? { test_output: testRunOutcome } : {});
    return { ok: true, taskId: task.id, iterations: chat.iterations, tool_calls: chat.toolCallsMade.length, test_runner: testRunOutcome ? { run_status: testRunOutcome.run_status, exit_code: testRunOutcome.exit_code } : null };
  } catch (e) {
    await finishRun(task.id, "failed", String(e.message || e));
    return { ok: false, error: String(e.message || e), taskId: task.id };
  }
}

async function tick() {
  // T3: claim a single Task per tick. Server returns 204 when nothing matches
  // this worker's assignee_id + role_allowlist; the poll-loop sleeps and retries.
  const task = await claimFromServer();
  if (!task) return { polled: 0 };
  log("info", "tick_claimed", { taskId: task.id });
  const res = await executeOne(task);
  log("info", "task_done", { taskId: task.id, res });
  return { polled: 1 };
}

async function main() {
  log("info", "boot", { role: ROLE_HINT, model: MODEL, assignee_id: WORKER_ASSIGNEE_ID, ollama: OLLAMA_URL, ctx: CTX_API });
  try { await ensureWorkerNode(); log("info", "worker_node_ready", { id: WORKER_ID }); }
  catch (e) { log("error", "worker_node_init_failed", { err: e.message }); }
  if (ROLE_HINT === "pm") {
    try { await ensurePushbackSchema(); log("info", "pushback_schema_ready"); }
    catch (e) { log("error", "pushback_schema_init_failed", { err: e.message }); }
  }
  if (ROLE_HINT === "qa") {
    try { await ensureQaSchema(); log("info", "qa_schema_ready"); }
    catch (e) { log("error", "qa_schema_init_failed", { err: e.message }); }
  }
  if (["be","fe","do"].includes(ROLE_HINT)) {
    try { await ensureTestOutputCol(); log("info", "test_output_col_ready"); }
    catch (e) { log("error", "test_output_col_init_failed", { err: e.message }); }
  }
  if (process.argv.includes("--once")) {
    await tick();
    await pool.end();
    return;
  }
  for (;;) {
    try { await tick(); } catch (e) { log("error", "tick_err", { err: e.message }); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(e => { log("error", "fatal", { err: e.message }); process.exit(1); });
