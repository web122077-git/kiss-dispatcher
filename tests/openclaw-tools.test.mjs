// Unit test: openclaw-mcp gating + allow-list enforcement.
// T4 of openclaw-spike-zdev-2026-05. Verifies:
//  - DO advertises the 3 openclaw_* tools only when OPENCLAW_MCP_URL is set
//  - PM never advertises them (role gate)
//  - executeTool rejects an openclaw call from PM (allow-list violation)
//  - executeTool from DO with no URL returns "openclaw not configured"
//  - All 3 openclaw_* schemas have correct OpenAI-function-calling shape

import { buildRoleTools, TOOL_SCHEMAS, executeTool } from "../src/tools.mjs";

let pass = 0, fail = 0;
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} expect=${JSON.stringify(expected)}`);
  if (ok) pass++; else fail++;
}
function checkTrue(name, got) {
  const ok = !!got;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)}`);
  if (ok) pass++; else fail++;
}

// ── Gating: env unset ────────────────────────────────────────────────────
const unset = buildRoleTools({ OPENCLAW_MCP_URL: "" });
check("env-unset: DO does NOT advertise openclaw_chat_async", unset.do.includes("openclaw_chat_async"), false);
check("env-unset: DO does NOT advertise openclaw_task_status", unset.do.includes("openclaw_task_status"), false);
check("env-unset: DO does NOT advertise openclaw_task_cancel", unset.do.includes("openclaw_task_cancel"), false);
check("env-unset: PM does NOT advertise openclaw_chat_async", unset.pm.includes("openclaw_chat_async"), false);

// ── Gating: env set ──────────────────────────────────────────────────────
const set = buildRoleTools({ OPENCLAW_MCP_URL: "http://10.98.98.33:3000" });
check("env-set: DO advertises openclaw_chat_async", set.do.includes("openclaw_chat_async"), true);
check("env-set: DO advertises openclaw_task_status", set.do.includes("openclaw_task_status"), true);
check("env-set: DO advertises openclaw_task_cancel", set.do.includes("openclaw_task_cancel"), true);

// Acceptance criteria: "DO advertises 3 openclaw_* tools"
const doOpenclaw = set.do.filter(t => t.startsWith("openclaw_"));
check("env-set: DO advertises EXACTLY 3 openclaw_* tools", doOpenclaw.length, 3);

// ── Allow-list violation: PM must NOT get openclaw tools even when env set ──
check("env-set: PM does NOT advertise openclaw_chat_async", set.pm.includes("openclaw_chat_async"), false);
check("env-set: PM does NOT advertise openclaw_task_status", set.pm.includes("openclaw_task_status"), false);
check("env-set: PM does NOT advertise openclaw_task_cancel", set.pm.includes("openclaw_task_cancel"), false);

// CPM / TL / BE / FE / QA / DOC / CLOSER: same — none should pick up openclaw
for (const role of ["cpm", "tl", "be", "fe", "qa", "doc", "closer"]) {
  check(`env-set: ${role} does NOT advertise openclaw_chat_async`, set[role].includes("openclaw_chat_async"), false);
}

// ── Schemas: shape check ────────────────────────────────────────────────
for (const name of ["openclaw_chat_async", "openclaw_task_status", "openclaw_task_cancel"]) {
  const s = TOOL_SCHEMAS[name];
  checkTrue(`schema ${name} exists`, s != null);
  check(`schema ${name}.type`, s?.type, "function");
  check(`schema ${name}.function.name`, s?.function?.name, name);
  checkTrue(`schema ${name}.function.description nonempty`, (s?.function?.description || "").length > 20);
  checkTrue(`schema ${name}.function.parameters is object`, s?.function?.parameters?.type === "object");
}

// openclaw_chat_async required: prompt
check("openclaw_chat_async requires prompt", TOOL_SCHEMAS.openclaw_chat_async.function.parameters.required, ["prompt"]);
check("openclaw_task_status requires task_id", TOOL_SCHEMAS.openclaw_task_status.function.parameters.required, ["task_id"]);
check("openclaw_task_cancel requires task_id", TOOL_SCHEMAS.openclaw_task_cancel.function.parameters.required, ["task_id"]);

// ── Allow-list enforcement at executeTool ────────────────────────────────
// PM trying openclaw_chat_async (role gate rejects before exec):
const pmTry = await executeTool("openclaw_chat_async", { prompt: "hi" }, "pm");
const pmTryJ = JSON.parse(pmTry);
check("executeTool: PM is rejected by allow-list", pmTryJ.ok, false);
checkTrue("executeTool: PM rejection mentions allow-list", String(pmTryJ.error || "").includes("allow-list"));

// DO with no OPENCLAW_MCP_URL — should still be rejected by allow-list at
// import time, since ROLE_TOOLS.do was built with no env at module load.
// (process.env.OPENCLAW_MCP_URL was NOT set when this file imported tools.mjs.)
// Confirms the boot-time gate works:
const doImportGate = await executeTool("openclaw_chat_async", { prompt: "hi" }, "do");
const doImportGateJ = JSON.parse(doImportGate);
check("executeTool: DO without env is also rejected (boot-time gate)", doImportGateJ.ok, false);

// Bypassing role hint (back-compat): executor lookup should still hit the openclaw
// branch and return the "not configured" message because env is unset.
const noRole = await executeTool("openclaw_chat_async", { prompt: "hi" });
const noRoleJ = JSON.parse(noRole);
check("executeTool: no role hint → falls through to executor", noRoleJ.ok, false);
checkTrue("executeTool: no-env executor returns 'openclaw not configured'", String(noRoleJ.error || "").includes("openclaw not configured"));

// ── Done ────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
