// Unit tests for complexityBump — mocks pg pool and fetch.
// Run: node tests/test_complexity_bump.mjs from repo root.

import { complexityBump } from "../src/routing.mjs";

let pass = 0, fail = 0;
function assert(label, got, expected) {
  if (got === expected) { console.log(`  PASS  ${label}`); pass++; }
  else { console.error(`  FAIL  ${label}: expected ${expected}, got ${got}`); fail++; }
}

// ── Mock helpers ──────────────────────────────────────────────────────────────
function mockPool({ redispatch = 0, qaRevises = 0 }) {
  return {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes("dispatcher_runs")) return { rows: [{ redispatch_count: redispatch }] };
          if (sql.includes("qa_verdicts"))     return { rows: [{ c: qaRevises }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

const logs = [];
const mockLog = (level, event, data) => logs.push({ level, event, data });

// Reset fetch to capture PATCH calls
const patches = [];
global.fetch = async (url, opts) => {
  if (opts?.method === "PATCH") patches.push({ url, body: JSON.parse(opts.body) });
  return { ok: true };
};

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log("=== complexityBump unit tests ===");

// No failures → no bump, no PATCH
{
  patches.length = 0;
  const task = { id: "t1", parent_id: "s1", metadata: {} };
  const score = await complexityBump(task, { pool: mockPool({ redispatch: 0, qaRevises: 0 }), ctxApi: "http://x", log: mockLog });
  assert("no failures → score unchanged (2)", score, 2);
  assert("no failures → no PATCH", patches.length, 0);
}

// redispatch >= 2 → +1
{
  patches.length = 0;
  const task = { id: "t2", parent_id: "s2", metadata: {} };
  const score = await complexityBump(task, { pool: mockPool({ redispatch: 2, qaRevises: 0 }), ctxApi: "http://x", log: mockLog });
  assert("redispatch=2 → base+1 (3)", score, 3);
  assert("redispatch=2 → PATCH fired", patches.length, 1);
  assert("PATCH writes effective_complexity=3", patches[0].body.metadata.effective_complexity, 3);
}

// qa_revises >= 2 → +1
{
  patches.length = 0;
  const task = { id: "t3", parent_id: "s3", metadata: {} };
  const score = await complexityBump(task, { pool: mockPool({ redispatch: 0, qaRevises: 3 }), ctxApi: "http://x", log: mockLog });
  assert("qa_revises=3 → base+1 (3)", score, 3);
  assert("qa bump → PATCH fired", patches.length, 1);
}

// Both signals → +2
{
  patches.length = 0;
  const task = { id: "t4", parent_id: "s4", metadata: {} };
  const score = await complexityBump(task, { pool: mockPool({ redispatch: 3, qaRevises: 4 }), ctxApi: "http://x", log: mockLog });
  assert("both signals → base+2 (4)", score, 4);
}

// Already at 5 — no further bump
{
  patches.length = 0;
  const task = { id: "t5", parent_id: "s5", metadata: { effective_complexity: 5 } };
  const score = await complexityBump(task, { pool: mockPool({ redispatch: 5, qaRevises: 5 }), ctxApi: "http://x", log: mockLog });
  assert("already at 5 → stays 5", score, 5);
  assert("already at 5 → no PATCH (no change)", patches.length, 0);
}

// PG error → fail-open, returns base estimate unchanged
{
  patches.length = 0;
  const badPool = { connect: async () => { throw new Error("connection refused"); } };
  const task = { id: "t6", parent_id: "s6", metadata: {} };
  const score = await complexityBump(task, { pool: badPool, ctxApi: "http://x", log: mockLog });
  assert("pg error → fail-open returns base (2)", score, 2);
  assert("pg error → no PATCH", patches.length, 0);
}

// complexity_hint anchors base before bump
{
  patches.length = 0;
  const task = { id: "t7", parent_id: "s7", metadata: { complexity_hint: 3 } };
  const score = await complexityBump(task, { pool: mockPool({ redispatch: 2, qaRevises: 0 }), ctxApi: "http://x", log: mockLog });
  assert("hint=3 + redispatch=2 → 4", score, 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
