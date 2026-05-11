// Unit test: diffTouchesGoss matches T2i goss-path detection.
// Inline the regex/function (matches src/index.mjs definitions) so we can
// run without importing the auto-running index.mjs.

const GOSS_PATH_PATTERNS = [
  /\/goss\.yaml/i,
  /\/goss\.yml/i,
  /\/etc\/goss\//i,
  /playbooks\/.*goss.*\.ya?ml/i,
];

function diffTouchesGoss(diff) {
  if (!diff) return false;
  const lines = diff.split("\n").filter(l => l.startsWith("+++ ") || l.startsWith("--- "));
  for (const l of lines) {
    for (const re of GOSS_PATH_PATTERNS) {
      if (re.test(l)) return true;
    }
  }
  return false;
}

const cases = [
  { name: "/etc/goss/goss.yaml", diff: "--- a/etc/goss/goss.yaml\n+++ b/etc/goss/goss.yaml\n", expect: true },
  { name: "goss.yaml in repo", diff: "--- a/roles/foo/files/goss.yaml\n+++ b/roles/foo/files/goss.yaml\n", expect: true },
  { name: "playbook 19_deploy_goss", diff: "--- a/playbooks/19_deploy_goss.yml\n+++ b/playbooks/19_deploy_goss.yml\n", expect: true },
  { name: "non-goss systemd unit", diff: "--- a/etc/systemd/system/foo.service\n+++ b/etc/systemd/system/foo.service\n", expect: false },
  { name: "non-goss js file", diff: "--- a/src/index.js\n+++ b/src/index.js\n", expect: false },
  { name: "goss in body but not header", diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new with goss.yaml mention\n", expect: false },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = diffTouchesGoss(c.diff);
  const ok = got === c.expect;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${c.name}: got=${got} expect=${c.expect}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
