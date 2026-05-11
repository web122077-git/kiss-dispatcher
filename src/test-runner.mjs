// kiss-dispatcher test-runner subroutine
// Apply a unified diff to a sandbox clone of the target repo, run the test
// command, capture exit + stdout + stderr. Returns a structured object the
// dispatcher writes onto dispatcher_runs.test_output and onto QA hints.
//
// Safety posture:
// - Sandbox = a temp dir clone of the target repo (no shared state).
// - test_command runs with a hard timeout (default 5 min, capped at 15 min).
// - stdout/stderr captured up to 64 KiB each (truncated tail kept).
// - No network egress restriction at this layer (zdev-trigger LXC is the
//   network boundary). For prod hardening, wrap in a chroot or container —
//   filed as test-runner-prod-hardening follow-up.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min
const MAX_TIMEOUT_MS     = 15 * 60 * 1000;  // 15 min cap
const MAX_OUTPUT_BYTES   = 64 * 1024;       // 64 KiB per stream

function runId() {
  return Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
}

async function sh(cmd, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, { cwd, env: env || process.env });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killed = false;
    const tm = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([stdout, d]).subarray(0, MAX_OUTPUT_BYTES);
      }
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr = Buffer.concat([stderr, d]).subarray(0, MAX_OUTPUT_BYTES);
      }
    });
    child.on("error", (err) => {
      clearTimeout(tm);
      resolve({
        ok: false, exit_code: -1, signal: null, killed,
        stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") + "\n[spawn-error] " + err.message,
        runtime_seconds: (Date.now() - start) / 1000,
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(tm);
      resolve({
        ok: code === 0,
        exit_code: code === null ? -1 : code,
        signal,
        killed,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        runtime_seconds: (Date.now() - start) / 1000,
      });
    });
  });
}

// Main entry. Returns {run_status, exit_code, stdout, stderr, runtime_seconds, sandbox_path}
// run_status ∈ {ok, fail, apply_failed, timeout, no_diff, no_test_command, target_repo_missing, internal_error}
export async function runTest({ targetRepo, diff, testCommand, timeoutMs, log }) {
  const result = {
    run_status: "internal_error",
    target_repo: targetRepo, test_command: testCommand,
    exit_code: null, stdout: "", stderr: "",
    runtime_seconds: 0, sandbox_path: null,
  };
  if (!diff || diff.length < 5) { result.run_status = "no_diff"; return result; }
  if (!testCommand) { result.run_status = "no_test_command"; return result; }
  if (!targetRepo) { result.run_status = "target_repo_missing"; return result; }

  // Resolve absolute target_repo. Refuse paths that escape /10310L/repos or /opt.
  const abs = path.resolve(targetRepo);
  if (!(abs.startsWith("/10310L/repos/") || abs.startsWith("/opt/"))) {
    result.run_status = "target_repo_missing";
    result.stderr = `refused target_repo outside /10310L/repos or /opt: ${abs}`;
    return result;
  }
  try { await fs.access(abs); } catch { result.run_status = "target_repo_missing"; result.stderr = `target_repo not found: ${abs}`; return result; }

  // Sandbox dir
  const sandbox = path.join(os.tmpdir(), "kiss-test-runner", runId());
  result.sandbox_path = sandbox;
  await fs.mkdir(sandbox, { recursive: true });

  try {
    if (log) log("info", "test_runner_clone", { from: abs, to: sandbox });
    // Use cp -a for speed; rsync would also work. Skip .git/ to keep small.
    const clone = await sh("cp", ["-a", abs + "/.", sandbox]);
    if (!clone.ok) {
      result.run_status = "internal_error";
      result.stderr = "clone failed: " + clone.stderr;
      return result;
    }

    // Write the diff to a temp file then git-apply (works without a .git when --whitespace=nowarn --include is omitted; use patch -p1 as fallback)
    const diffPath = path.join(sandbox, ".kiss-diff.patch");
    await fs.writeFile(diffPath, diff, "utf8");

    if (log) log("info", "test_runner_apply", { diffPath });
    // Prefer git apply (handles renames, new files). Fall back to patch -p1.
    let apply = await sh("git", ["apply", "--whitespace=nowarn", diffPath], { cwd: sandbox, timeoutMs: 30_000 });
    if (!apply.ok) {
      const patchFallback = await sh("patch", ["-p1", "-i", diffPath], { cwd: sandbox, timeoutMs: 30_000 });
      if (!patchFallback.ok) {
        result.run_status = "apply_failed";
        result.stdout = apply.stdout + "\n[fallback patch]\n" + patchFallback.stdout;
        result.stderr = apply.stderr + "\n[fallback patch]\n" + patchFallback.stderr;
        return result;
      }
    }

    // Run the test command. Use bash -lc so the submitter can pass complex commands.
    const tm = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (log) log("info", "test_runner_exec", { testCommand, timeoutMs: tm });
    const run = await sh("bash", ["-lc", testCommand], { cwd: sandbox, timeoutMs: tm });
    result.run_status = run.killed ? "timeout" : (run.ok ? "ok" : "fail");
    result.exit_code = run.exit_code;
    result.stdout = run.stdout;
    result.stderr = run.stderr;
    result.runtime_seconds = run.runtime_seconds;
    return result;
  } catch (e) {
    result.run_status = "internal_error";
    result.stderr = String(e.message || e);
    return result;
  } finally {
    // Clean up sandbox unless KISS_TESTRUNNER_KEEP=1
    if (process.env.KISS_TESTRUNNER_KEEP !== "1") {
      try { await fs.rm(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
