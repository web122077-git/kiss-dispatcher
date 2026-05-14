/**
 * Unit tests for selectBackend() and getSystemState()
 * Run: node tests/test_select_backend.mjs from repo root
 */

import { selectBackend, getSystemState } from "../src/routing.mjs";

let pass = 0, fail = 0;
function assert(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected)
    || (typeof expected === "function" && expected(got));
  if (ok) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${typeof expected === "function" ? "(predicate)" : JSON.stringify(expected)}`);
    console.error(`        got:      ${JSON.stringify(got)}`);
    fail++;
  }
}

// ── Shared test fixtures ──────────────────────────────────────────────────────

const BACKENDS = [
  {
    id: "ollama1", url: "http://10.50.50.11:11434", type: "ollama",
    capabilities: ["tool_use", "streaming"], cost_tier: "local", max_parallel: 1,
    models: [
      { id: "small-model:7b",   tier: "small",  size_gb: 4.5 },
      { id: "medium-model:14b", tier: "medium", size_gb: 9.0 },
      { id: "large-model:27b",  tier: "large",  size_gb: 16.0 },
    ],
  },
  {
    id: "ollama2", url: "http://10.50.50.12:11434", type: "ollama",
    capabilities: ["tool_use", "streaming"], cost_tier: "local", max_parallel: 1,
    models: [
      { id: "medium-model:14b", tier: "medium", size_gb: 9.0 },
      { id: "large-model:27b",  tier: "large",  size_gb: 16.0 },
    ],
  },
  {
    id: "openclaw", url: "http://10.98.98.33:18789", type: "openai_compat",
    capabilities: ["tool_use", "long_context"], cost_tier: "local", max_parallel: 4,
    models: [{ id: "openclaw", tier: "xlarge" }],
  },
  {
    id: "claude-api", url: "https://api.anthropic.com", type: "openai_compat",
    capabilities: ["tool_use", "vision", "long_context"], cost_tier: "api", max_parallel: 10,
    models: [{ id: "claude-sonnet-4-5", tier: "xlarge" }],
  },
];

const PERSONA_CODER = {
  id: "be",
  routing: {
    preferred_backends: ["ollama1", "ollama2"],
    preferred_tier: "medium",
    cost_ceiling: "local",
    escalation: {
      complexity_threshold: 3,
      escalated_tier: "large",
      backends: ["ollama1", "ollama2"],
    },
  },
};

console.log("=== selectBackend unit tests ===\n");

// ── Test 1: normal complexity → first preferred backend, preferred tier ───────
{
  const task = { title: "Add health endpoint", description: "Add GET /health returning 200." };
  const r = await selectBackend(task, PERSONA_CODER, BACKENDS, {});
  assert("normal: picks ollama1",       r.backendUrl, "http://10.50.50.11:11434");
  assert("normal: medium tier model",   r.model,      "medium-model:14b");
  assert("normal: not escalated",       r._routing_meta.escalated, false);
  assert("normal: apiShape null",       r.apiShape,   null);
}

// ── Test 2: escalated complexity → escalated tier ─────────────────────────────
{
  const task = {
    title: "Refactor auth middleware",
    description: "Rewrite the entire authentication layer migrating from Redis to Postgres. " +
      "Affects src/auth/middleware.ts, src/session/store.ts, config/auth.yml. " +
      "Must be zero-downtime with feature flag. " +
      "Update all 12 dependent services and rewrite integration tests. More text to make it long enough " +
      "to push past the length threshold via the refactor keyword combined with this long description.",
  };
  const r = await selectBackend(task, PERSONA_CODER, BACKENDS, {});
  assert("escalated: escalated=true",   r._routing_meta.escalated, true);
  assert("escalated: large tier model", r.model, "large-model:27b");
  assert("escalated: apiShape null",    r.apiShape, null);
}

// ── Test 3: hot model preferred over cold ─────────────────────────────────────
{
  const task = { title: "fix small bug", description: "One line fix." };
  // ollama1 has medium-model:14b hot, so even though small is also available it picks medium
  // (because persona preferred_tier=medium and medium-model is hot)
  const systemState = { hotModels: { ollama1: new Set(["medium-model:14b"]) } };
  const r = await selectBackend(task, PERSONA_CODER, BACKENDS, systemState);
  assert("hot: picks hot medium model", r.model, "medium-model:14b");
  assert("hot: hot=true in meta",       r._routing_meta.hot, true);
}

// ── Test 4: cost ceiling excludes api backend ──────────────────────────────────
{
  const personaLocalOnly = {
    id: "test",
    routing: {
      preferred_backends: ["claude-api", "ollama1"],
      preferred_tier: "medium",
      cost_ceiling: "local",
    },
  };
  const task = { title: "normal task", description: "do something" };
  const r = await selectBackend(task, personaLocalOnly, BACKENDS, {});
  // claude-api is cost_tier=api, exceeds local ceiling → skipped; ollama1 matches
  assert("cost_ceiling: skips api backend", r.backendUrl, "http://10.50.50.11:11434");
}

// ── Test 5: openai_compat backend → apiShape=openai ───────────────────────────
{
  const personaOpenClaw = {
    id: "openclaw",
    routing: {
      preferred_backends: ["openclaw"],
      preferred_tier: "xlarge",
      cost_ceiling: "local",
    },
  };
  const task = { title: "review code", description: "review PR" };
  const r = await selectBackend(task, personaOpenClaw, BACKENDS, {});
  assert("openclaw: apiShape=openai", r.apiShape, "openai");
  assert("openclaw: model=openclaw",  r.model, "openclaw");
}

// ── Test 6: no model at target tier → skip backend, try next ─────────────────
{
  const personaXlarge = {
    id: "test",
    routing: {
      preferred_backends: ["ollama1", "openclaw"],
      preferred_tier: "xlarge",
      cost_ceiling: "local",
    },
  };
  const task = { title: "big task", description: "needs xlarge" };
  const r = await selectBackend(task, personaXlarge, BACKENDS, {});
  // ollama1 has no xlarge tier model → skips; openclaw has xlarge
  assert("tier_skip: skips to next backend", r.backendUrl, "http://10.98.98.33:18789");
}

// ── Test 7: no matching backend at all → fallback ─────────────────────────────
{
  const personaNoMatch = {
    id: "test",
    routing: {
      preferred_backends: ["does-not-exist"],
      preferred_tier: "medium",
      cost_ceiling: "local",
    },
  };
  delete process.env.OLLAMA_URL;
  delete process.env.MODEL;
  const task = { title: "task", description: "something" };
  const r = await selectBackend(task, personaNoMatch, BACKENDS, {});
  assert("fallback: uses default url",   r.backendUrl, "http://10.50.50.11:11434");
  assert("fallback: fallback_reason",    r._routing_meta.fallback_reason, "no_matching_backend");
}

// ── Test 8: escalation by effective_complexity override ───────────────────────
{
  const task = {
    title: "trivial task",
    description: "one word",
    metadata: { effective_complexity: 4 }, // bumped by T4
  };
  const r = await selectBackend(task, PERSONA_CODER, BACKENDS, {});
  assert("eff_complexity: escalated=true", r._routing_meta.escalated, true);
  assert("eff_complexity: large model",    r.model, "large-model:27b");
}

// ── Test 9: getSystemState fail-open (unreachable backend) ────────────────────
{
  const backends = [{
    id: "dead", url: "http://192.0.2.1:11434", type: "ollama",
    models: [],
  }];
  const state = await getSystemState(backends);
  assert("getSystemState: fail-open empty set", state.hotModels.dead instanceof Set, true);
  assert("getSystemState: empty on timeout",    state.hotModels.dead.size, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
