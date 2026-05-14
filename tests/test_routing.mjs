// Quick unit test for complexityEstimate — run with: node test_routing.mjs
// Mirrors the assertions the CI gate (T5 extension) will enforce.

import { complexityEstimate } from "../src/routing.mjs";

let pass = 0, fail = 0;
function assert(label, got, expected) {
  if (got === expected) {
    console.log(`  PASS  ${label}: ${got}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}: expected ${expected}, got ${got}`);
    fail++;
  }
}

console.log("=== complexityEstimate unit tests ===");

// Trivial task — short description, downweight keyword
assert("fix typo → 1",
  complexityEstimate({ title: "fix typo in README", description: "One word." }),
  1);

// Simple update
assert("bump version → 1",
  complexityEstimate({ title: "bump version to 1.2.3", description: "Update package.json." }),
  1);

// Normal task — medium length, no signals
assert("normal task → 2",
  complexityEstimate({ title: "Add health check endpoint", description: "Add GET /health that returns 200 OK. Wire into express app. Update goss spec to assert port 3000 responds." }),
  2);

// Explicit hint overrides base
assert("complexity_hint=4 → 4",
  complexityEstimate({ title: "do something", description: "short", metadata: { complexity_hint: 4 } }),
  4);

// effective_complexity from bump wins over all
assert("effective_complexity bump wins → 5",
  complexityEstimate({ title: "fix typo", description: "tiny", metadata: { effective_complexity: 5 } }),
  5);

// Refactor with long description → high
const longDesc = "Refactor the entire authentication middleware layer. " +
  "This involves extracting the JWT validation logic into a separate service, " +
  "migrating all session stores from Redis to Postgres, updating the Firewalla " +
  "rules, rewriting the token refresh flow, and updating 12 dependent services. " +
  "Files affected: `src/auth/middleware.ts`, `src/auth/jwt.ts`, `src/session/store.ts`, " +
  "`src/api/refresh.ts`, `config/firewalla.json`, `playbooks/auth.yml`. " +
  "The migration must be zero-downtime with a feature flag controlling rollout.";
assert("refactor + long desc → 5",
  complexityEstimate({ title: "Refactor auth middleware", description: longDesc }),
  5);

// Spike — moderate
assert("spike → 3",
  complexityEstimate({ title: "spike: evaluate complexity routing", description: "Research hollow-agentOS approach and compare to our role-based routing. Write up findings. Short doc." }),
  3);

// Audit — moderate
assert("audit → 3",
  complexityEstimate({ title: "audit persona config for drift", description: "Check each persona in personas.v7.json against the deployed envs on zdev-trigger. Flag mismatches. File tasks for each gap found." }),
  3);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
