// Unit test: test-runner subroutine — verify 6 run_status paths.
import { runTest } from "../src/test-runner.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const movedRepo = "/10310L/repos/.kiss-test-fixture-" + Date.now();
await fs.mkdir(movedRepo, { recursive: true });
await fs.writeFile(path.join(movedRepo, "hello.js"), "console.log('hello, world');\n");

const diff = `--- a/hello.js
+++ b/hello.js
@@ -1 +1,2 @@
 console.log('hello, world');
+console.log('hello, ci');
`;
const log = () => {}; // silent in CI
let pass = 0, fail = 0;

function check(name, got, expected) {
  const ok = got === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}: got=${got} expect=${expected}`);
  if (ok) pass++; else fail++;
}

try {
  const r1 = await runTest({ targetRepo: movedRepo, diff, testCommand: "node hello.js && echo OK", log });
  check("clean apply + green", r1.run_status, "ok");

  const badDiff = "--- a/no-such.js\n+++ b/no-such.js\n@@ -1 +1 @@\n-x\n+y\n";
  const r2 = await runTest({ targetRepo: movedRepo, diff: badDiff, testCommand: "true", log });
  check("apply_failed", r2.run_status, "apply_failed");

  const r3 = await runTest({ targetRepo: movedRepo, diff, testCommand: "exit 5", log });
  check("fail (exit 5)", r3.run_status, "fail");

  const r4 = await runTest({ targetRepo: "/tmp/no-such-xyz", diff, testCommand: "true", log });
  check("target_repo missing", r4.run_status, "target_repo_missing");

  const r5 = await runTest({ targetRepo: "/etc", diff, testCommand: "true", log });
  check("refused outside allowlist", r5.run_status, "target_repo_missing");

  const r6 = await runTest({ targetRepo: movedRepo, diff, testCommand: "sleep 60", timeoutMs: 3000, log });
  check("timeout", r6.run_status, "timeout");

  // no_diff and no_test_command
  const r7 = await runTest({ targetRepo: movedRepo, diff: "", testCommand: "true", log });
  check("no_diff", r7.run_status, "no_diff");

  const r8 = await runTest({ targetRepo: movedRepo, diff, testCommand: "", log });
  check("no_test_command", r8.run_status, "no_test_command");
} finally {
  await fs.rm(movedRepo, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
