#!/usr/bin/env node
// kiss-dispatcher — KISS PG-advisory-lock dispatcher with multi-turn tool loop.
//
// Architecture: per spike findings + Phase 2 T2a tool-call loop +
// decision-tools-per-role-not-batch-2026-05-11.

import pg from "pg";
import { chatWithTools } from "./ollama.mjs";
import { toolsForRole } from "./tools.mjs";

const PG_URL     = process.env.PG_URL     || "postgresql://postgres:kiss-spike-pw@10.98.98.34:5434/dispatcher";
const CTX_API    = (process.env.CTX_API   || "http://10.77.77.2:3001").replace(/\/$/, "");
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://10.50.50.11:11434").replace(/\/$/, "");
const MODEL      = process.env.MODEL      || "qwen3-coder:30b";
const WORKER_ID  = process.env.WORKER_ID  || `kiss-worker-${process.pid}`;
const ROLE_HINT  = process.env.ROLE_HINT  || "pm";
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

async function listClaimableTasks() {
  // /agile/task?status=todo list omits role_hint. Fetch list + GET each item for full props.
  // api-gap-task-list-include-role-hint-2026-05-11 fixes this server-side later.
  const r = await fetch(`${CTX_API}/agile/task?status=todo`);
  if (!r.ok) throw new Error(`list tasks: HTTP ${r.status}`);
  const wrap = await r.json();
  const stubs = Array.isArray(wrap) ? wrap : (wrap.items || []);
  const out = [];
  for (const stub of stubs) {
    if (!stub?.id) continue;
    const tr = await fetch(`${CTX_API}/agile/task/${encodeURIComponent(stub.id)}`);
    if (!tr.ok) continue;
    const t = await tr.json();
    if (t.role_hint === ROLE_HINT && t.status === "todo") out.push(t);
  }
  return out;
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

async function claimAndRecord(task) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockR = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got", [task.id]);
    if (lockR.rows[0]?.got !== true) { await client.query("ROLLBACK"); return { claimed: false, reason: "race-lost" }; }
    const cur = await getTaskStatus(task.id);
    if (cur !== "todo") { await client.query("ROLLBACK"); return { claimed: false, reason: `status-changed-to-${cur}` }; }
    await client.query(
      `INSERT INTO dispatcher_runs (task_id, role_hint, worker_id, status)
       VALUES ($1,$2,$3,'doing')
       ON CONFLICT (task_id) DO UPDATE
         SET worker_id=$3, claimed_at=now(), status='doing', result=NULL, finished_at=NULL,
             redispatch_count=dispatcher_runs.redispatch_count+1`,
      [task.id, task.role_hint, WORKER_ID]);
    await client.query("COMMIT");
    return { claimed: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { claimed: false, reason: `tx1-error: ${e.message}` };
  } finally { client.release(); }
}

async function finishRun(taskId, status, result, extra = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE dispatcher_runs SET status=$2, result=$3, finished_at=now() WHERE task_id=$1`,
      [taskId, status, (result || "").slice(0, 4096)]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log("error", "finishRun_failed", { taskId, err: e.message });
  } finally { client.release(); }
}

// ── Persona system prompts (loaded from personas.v7.json) ──────────────────

let PERSONAS = null;
async function loadPersonas() {
  if (PERSONAS) return PERSONAS;
  const fs = await import("node:fs/promises");
  const text = await fs.readFile("/10310L/repos/persona-config/personas.v7.json", "utf8");
  const j = JSON.parse(text);
  PERSONAS = {};
  for (const p of j.personas) PERSONAS[p.id] = p;
  return PERSONAS;
}

// ── Build the user prompt per role ──────────────────────────────────────────

function buildUserPrompt(task, persona) {
  // Phase 2 T2b will replace this with proper per-role shaping. For T2a we
  // keep a generic shape that exercises the tool-call loop.
  return `[TASK]
${task.title}

[DESCRIPTION]
${task.description || "(none)"}

[ACCEPTANCE CRITERIA]
${task.acceptance_criteria || "(none)"}

[YOUR ROLE]
You are ${persona.label || ROLE_HINT.toUpperCase()}. Per your system prompt, do your job for this Task.

[TOOL USE — read carefully]
- Use tools to ground your answer in real graph/source state, not to enumerate the catalog.
- After 1-3 successful tool calls, COMMIT to an answer. Do not keep gathering.
- If a tool returns 'Nothing found' or 404, the entity does not exist — DO NOT retry with variations of the name; treat the absence as fact and proceed.
- You may ONLY reference ids that came from a prior tool result. Do NOT invent ids (no epic-42, no node-foo).
- When you have what you need, emit your final response per your role's output shape and STOP calling tools.`;
}

// ── Executor — uses the tool loop ──────────────────────────────────────────

async function executeOne(task) {
  const claim = await claimAndRecord(task);
  if (!claim.claimed) return { skipped: true, reason: claim.reason };

  try {
    const personas = await loadPersonas();
    const persona = personas[ROLE_HINT];
    if (!persona) throw new Error(`no persona for role_hint=${ROLE_HINT}`);

    const tools = toolsForRole(ROLE_HINT);
    const messages = [
      { role: "system", content: persona.system_prompt },
      { role: "user",   content: buildUserPrompt(task, persona) },
    ];

    // PATCH to doing BEFORE the long model call so the board reflects state immediately.
    const setDoing = await patchTask(task.id, { status: "doing" });
    if (!setDoing.ok) throw new Error(`patch doing failed: ${setDoing.status} ${setDoing.body.slice(0,160)}`);

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

    const setDone = await patchTask(task.id, {
      status: "done",
      resolution: `[kiss-dispatcher ${WORKER_ID} model=${MODEL} role=${ROLE_HINT} tool_calls=${chat.toolCallsMade.length}] ${summary.slice(0, 480)}`,
    });
    if (!setDone.ok) throw new Error(`patch done failed: ${setDone.status} ${setDone.body.slice(0,160)}`);

    await finishRun(task.id, "done", summary);
    return { ok: true, taskId: task.id, iterations: chat.iterations, tool_calls: chat.toolCallsMade.length };
  } catch (e) {
    await finishRun(task.id, "failed", String(e.message || e));
    return { ok: false, error: String(e.message || e), taskId: task.id };
  }
}

async function tick() {
  const tasks = await listClaimableTasks();
  if (!tasks.length) return { polled: 0 };
  log("info", "tick", { candidates: tasks.length });
  for (const t of tasks) {
    const res = await executeOne(t);
    log("info", "task_done", { taskId: t.id, res });
  }
  return { polled: tasks.length };
}

async function main() {
  log("info", "boot", { role: ROLE_HINT, model: MODEL, ollama: OLLAMA_URL, ctx: CTX_API });
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
