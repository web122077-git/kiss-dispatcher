// Unit test: parseOutput fallback paths for prompt-eng-pm-output-shape-2026-05-11.
import { parseOutput } from "../src/prompts.mjs";

let pass = 0, fail = 0;
function check(name, got, expected) {
  const ok = got === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}: got=${got} expect=${expected}`);
  if (ok) pass++; else fail++;
}

// Path 1: clean ```json fence (the desired path)
const t1 = parseOutput("pm", '```json\n{"shape":"epic_decomposition","new_stories":[]}\n```');
check("fenced_json path ok", t1.ok, true);
check("fenced_json shape", t1.shape, "epic_decomposition");
check("fenced_json extracted_via", t1.extracted_via, "fenced_json");

// Path 2: ``` fenced (no language tag)
const t2 = parseOutput("pm", '```\n{"shape":"pm_pushback","epic_id":"x"}\n```');
check("fenced_any path ok", t2.ok, true);
check("fenced_any shape", t2.shape, "pm_pushback");
check("fenced_any extracted_via", t2.extracted_via, "fenced_any");

// Path 3: raw JSON, no fence at all (the failure mode the Task complained about)
const t3 = parseOutput("pm", 'Here is the decomposition: {"shape":"epic_decomposition","rationale":"x"} that should work');
check("raw_braces path ok", t3.ok, true);
check("raw_braces shape", t3.shape, "epic_decomposition");
check("raw_braces extracted_via", t3.extracted_via, "raw_braces");

// Path 4: still falls through cleanly on garbage
const t4 = parseOutput("pm", "just prose nothing parseable here");
check("garbage stays !ok", t4.ok, false);
check("garbage error", t4.error, "no_fenced_json_block");

// Path 5: empty short text
const t5 = parseOutput("pm", "x");
check("short stays !ok", t5.ok, false);
check("short error", t5.error, "empty_or_short_response");

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
