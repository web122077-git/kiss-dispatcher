#!/usr/bin/env node
// kiss-loop.mjs — KISS dispatcher loop: PG advisory-lock + two-phase bookkeeping.
//
// Phase 0 spike + split-brain fix (kiss-loop-bookkeeping-split-brain-fix-2026-05-11).
//
// Pattern:
//   1. Poll /agile/task?status=todo, filter to ROLE_HINT after per-task GET.
//   2. For each candidate:
//      a. tx1: BEGIN -> pg_try_advisory_xact_lock(hashtext(taskId)) -> on success,
//         re-check task status via GET /agile/task/<id> (skip if status != todo)
//         -> INSERT/UPSERT dispatcher_runs(status=doing) -> COMMIT
//         (advisory lock releases on COMMIT, but the "doing" row marks ownership)
//      b. PATCH /agile/task/<id> status=doing.
//      c. ollama call (long; no PG tx held).
//      d. PATCH /agile/task/<id> status=done,resolution=...
//      e. tx2: BEGIN -> UPDATE dispatcher_runs SET status=done,result,finished_at -> COMMIT.
//      Any failure between a..d marks the row 'failed' via a fresh tx.
//
// Race + split-brain claims:
//   - Two workers won't claim concurrently (advisory_xact_lock serializes tx1).
//   - dispatcher_runs row exists from the moment we commit tx1, so the board PATCH
//     and the row are never inconsistent for more than the tx2-update window.
//   - Stale-list workers see status!=todo on the re-check and skip.

import pg from "pg";

const PG_URL     = process.env.PG_URL     || "postgresql://postgres:kiss-spike-pw@10.98.98.34:5434/dispatcher";
const CTX_API    = process.env.CTX_API    || "http://10.77.77.2:3001";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://10.50.50.11:11434").replace(/\/$/, "");
const MODEL      = process.env.MODEL      || "qwen3-coder:30b";
const WORKER_ID  = process.env.WORKER_ID  || `kiss-worker-${process.pid}`;
const ROLE_HINT  = process.env.ROLE_HINT  || "pm";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });

async function listClaimableTasks() {
  // /agile/task?status=todo list omits role_hint. Fetch list + GET each item for full props.
  // (api-gap-task-list-include-role-hint-2026-05-11 fixes this server-side.)
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

async function callOllamaForPm(task) {
  const prompt = `You are PM. Summarize what shipping this Task would look like, in ONE sentence starting "Done when:".\n\nTitle: ${task.title}\nDescription: ${task.description || ""}\nAcceptance: ${task.acceptance_criteria || ""}\n`;
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_predict: 80, temperature: 0.2 } }),
  });
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
  const j = await r.json();
  return (j.response || "").trim();
}

// tx1: claim + record doing in one short tx
async function claimAndRecord(task) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockR = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got",
      [task.id]
    );
    if (lockR.rows[0]?.got !== true) {
      await client.query("ROLLBACK");
      return { claimed: false, reason: "race-lost" };
    }
    // Re-check status under the lock — list could be stale.
    const cur = await getTaskStatus(task.id);
    if (cur !== "todo") {
      await client.query("ROLLBACK");
      return { claimed: false, reason: `status-changed-to-${cur}` };
    }
    await client.query(
      `INSERT INTO dispatcher_runs (task_id, role_hint, worker_id, status)
       VALUES ($1,$2,$3,'doing')
       ON CONFLICT (task_id) DO UPDATE
         SET worker_id=$3, claimed_at=now(), status='doing', result=NULL, finished_at=NULL,
             redispatch_count=dispatcher_runs.redispatch_count+1`,
      [task.id, task.role_hint, WORKER_ID]
    );
    await client.query("COMMIT");
    return { claimed: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { claimed: false, reason: `tx1-error: ${e.message}` };
  } finally {
    client.release();
  }
}

// tx2: short tx to flip the row to done/failed
async function finishRun(taskId, status, result) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE dispatcher_runs
       SET status=$2, result=$3, finished_at=now()
       WHERE task_id=$1`,
      [taskId, status, (result || "").slice(0, 4096)]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Last-ditch best-effort: log to stderr, don't throw.
    console.error(`[kiss] finishRun failed for ${taskId}: ${e.message}`);
  } finally {
    client.release();
  }
}

async function executeOne(task) {
  const claim = await claimAndRecord(task);
  if (!claim.claimed) return { skipped: true, reason: claim.reason };

  // From here on, the dispatcher_runs row exists with status='doing'.
  // ANY exit path must update the row to done/failed via tx2.
  try {
    const setDoing = await patchTask(task.id, { status: "doing" });
    if (!setDoing.ok) throw new Error(`patch doing failed: ${setDoing.status} ${setDoing.body.slice(0,160)}`);

    const summary = await callOllamaForPm(task);
    if (!summary || summary.length < 10) throw new Error("model reply too short");

    const setDone = await patchTask(task.id, {
      status: "done",
      resolution: `[kiss-loop ${WORKER_ID} model=${MODEL}] ${summary.slice(0, 480)}`,
    });
    if (!setDone.ok) throw new Error(`patch done failed: ${setDone.status} ${setDone.body.slice(0,160)}`);

    await finishRun(task.id, "done", summary);
    return { ok: true, taskId: task.id, summary: summary.slice(0, 200) };
  } catch (e) {
    await finishRun(task.id, "failed", String(e.message || e));
    return { ok: false, error: String(e.message || e), taskId: task.id };
  }
}

async function tick() {
  const tasks = await listClaimableTasks();
  if (!tasks.length) return { polled: 0 };
  console.log(`[kiss] tick: ${tasks.length} candidate(s)`);
  for (const t of tasks) {
    const res = await executeOne(t);
    console.log(`[kiss] ${t.id}: ${JSON.stringify(res).slice(0, 240)}`);
  }
  return { polled: tasks.length };
}

async function main() {
  console.log(`[kiss] worker=${WORKER_ID} role=${ROLE_HINT} model=${MODEL} pg=${PG_URL.replace(/:[^:@]+@/, ":***@")} ctx=${CTX_API} ollama=${OLLAMA_URL}`);
  if (process.argv.includes("--once")) {
    await tick();
    await pool.end();
    return;
  }
  for (;;) {
    try { await tick(); } catch (e) { console.error("[kiss] tick err:", e.message); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(e => { console.error("[kiss] fatal:", e); process.exit(1); });
