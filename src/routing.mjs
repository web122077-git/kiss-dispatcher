/**
 * routing.mjs — kiss-dispatcher routing layer
 *
 * Implements the three-layer routing abstraction from
 * ADR adr-routing-abstraction-2026-05-14.
 *
 * Exports:
 *   complexityEstimate(task)  → integer 1-5
 *   selectBackend(task, persona, backends, systemState) → {backendUrl, model, options}
 *
 * T3 (this file): complexityEstimate() heuristic
 * T5: selectBackend() — stubbed here, full impl in T5
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKENDS_PATH = process.env.BACKENDS_PATH ||
  join(__dirname, "../../persona-config/backends.json");

// ── Keyword signals ───────────────────────────────────────────────────────────
// Applied to lowercased title + description. Total clamped to [-1.5, +2].
const KEYWORD_SIGNALS = [
  // Strong upweights (+1)
  [/\brefactor\b/,      +1.0],
  [/\brewrite\b/,       +1.0],
  [/\bmigrat/,          +1.0],
  [/\bredesign\b/,      +1.0],
  [/\boverhaul\b/,      +1.0],
  // Medium upweights (+0.8)
  [/\breplace\b/,       +0.8],
  [/\barchitecture\b/,  +0.8],
  [/\bspike\b/,         +0.5],
  [/\baudit\b/,         +0.8],
  [/\bevaluate\b/,      +0.5],
  // Soft upweights (+0.5)
  [/\bextract\b/,       +0.5],
  [/\bdesign\b/,        +0.5],
  [/\bplan\b/,          +0.3],
  [/\bsystem\b/,        +0.3],
  // Downweights
  [/\bfix typo\b/,      -1.5],
  [/\bbump version\b/,  -1.0],
  [/\bbump\b/,          -0.8],
  [/\brename\b/,        -0.5],
  [/\bminor\b/,         -0.5],
  [/\bcleanup\b/,       -0.3],
  [/\badd comment\b/,   -0.5],
  [/\bupdate config\b/, -0.3],
  [/\bupdate docs\b/,   -0.3],
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function tokenCount(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

function fileRefCount(text) {
  const matches = (text || "").match(
    /`[^`]+\.[a-zA-Z0-9]{1,8}`|(?:^|\s)([\w./-]+\/[\w./-]+\.[a-zA-Z0-9]{1,8})/gm
  ) || [];
  return new Set(matches.map(m => m.trim())).size;
}

// ── complexityEstimate ────────────────────────────────────────────────────────
/**
 * Estimate task complexity as an integer 1-5.
 *
 * Priority order:
 *   1. task.metadata.effective_complexity — written by T4 bump logic; always wins.
 *   2. task.metadata.complexity_hint — human-set anchor; returned directly.
 *   3. Heuristic: base(2) + keyword_delta + length_delta + fileref_delta.
 *
 * Heuristic signals:
 *   keyword delta  [-1.5, +2.0]  — table above
 *   length delta   [0,    +1.0]  — only upweights (>100 tokens → +0.5, >300 → +1)
 *   fileref delta  [0,    +1.0]  — distinct file paths in description
 */
export function complexityEstimate(task) {
  const meta = task.metadata || {};

  // 1. Bump result wins unconditionally.
  if (meta.effective_complexity != null) {
    const v = parseInt(meta.effective_complexity, 10);
    if (v >= 1 && v <= 5) return v;
  }

  // 2. Explicit human hint is returned as-is (no further modification).
  if (meta.complexity_hint != null) {
    const v = parseInt(meta.complexity_hint, 10);
    if (v >= 1 && v <= 5) return v;
  }

  // 3. Heuristic.
  const text = `${task.title || ""} ${task.description || ""}`.toLowerCase();
  let score = 2;

  // Keyword delta.
  let kwDelta = 0;
  for (const [re, delta] of KEYWORD_SIGNALS) {
    if (re.test(text)) kwDelta += delta;
  }
  score += Math.max(-1.5, Math.min(2, kwDelta));

  // Length delta — upweight only (short descriptions are normal for homelab tasks).
  const tokens = tokenCount(task.description);
  if (tokens > 300)      score += 1;
  else if (tokens > 100) score += 0.5;

  // File reference delta.
  const refs = fileRefCount(task.description);
  if (refs >= 9)       score += 1;
  else if (refs >= 4)  score += 0.5;

  return Math.max(1, Math.min(5, Math.round(score)));
}

// ── loadBackends ──────────────────────────────────────────────────────────────
let _backendsCache = null;
export async function loadBackends() {
  if (_backendsCache) return _backendsCache;
  const raw = await readFile(BACKENDS_PATH, "utf8");
  _backendsCache = JSON.parse(raw).backends || [];
  return _backendsCache;
}


// ── complexityBump ────────────────────────────────────────────────────────────
/**
 * Re-score a task's complexity based on observed failure signals and write
 * effective_complexity back to task metadata if the score increases.
 *
 * Called from executeOne() right after recordRunStart() so redispatch_count
 * is already incremented in PG before we read it.
 *
 * Bump rules (additive, cap at +2 total, final value clamped to [1,5]):
 *   redispatch_count >= 2  → +1  (same task claimed/failed multiple times)
 *   qa_revise_count  >= 2  → +1  (QA sent this story back repeatedly)
 *
 * @param {object} task       — full task node (needs .id, .parent_id, .metadata)
 * @param {object} deps       — { pool, ctxApi, log }
 * @returns {Promise<number>} — the (possibly unchanged) effective_complexity
 */
export async function complexityBump(task, { pool, ctxApi, log }) {
  const base = complexityEstimate(task);  // respects existing effective_complexity
  let bump = 0;

  try {
    // 1. redispatch_count from dispatcher_runs
    const client = await pool.connect();
    try {
      const rr = await client.query(
        `SELECT redispatch_count FROM dispatcher_runs WHERE task_id=$1`,
        [task.id]
      );
      const redispatch = rr.rows[0]?.redispatch_count ?? 0;
      if (redispatch >= 2) bump += 1;

      // 2. qa_revise_count from qa_verdicts for this story
      if (task.parent_id) {
        const qr = await client.query(
          `SELECT COUNT(*)::int AS c FROM qa_verdicts
           WHERE story_id=$1 AND verdict='revise' AND red_flag IS NULL`,
          [task.parent_id]
        );
        const qaRevises = qr.rows[0]?.c ?? 0;
        if (qaRevises >= 2) bump += 1;
      }
    } finally { client.release(); }
  } catch (err) {
    log?.("warn", "complexityBump_pg_error", { taskId: task.id, err: err.message });
    return base;  // fail-open: return current estimate unchanged
  }

  if (bump === 0) return base;

  const newScore = Math.min(5, base + bump);
  if (newScore === base) return base;  // already at effective value, no PATCH needed

  // Write effective_complexity into task metadata.
  try {
    const existing = task.metadata || {};
    await fetch(`${ctxApi}/agile/task/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metadata: {
          ...existing,
          effective_complexity: newScore,
          complexity_bump_reasons: [
            ...(existing.complexity_bump_reasons || []),
            { at: new Date().toISOString(), base, bump, new: newScore },
          ],
        },
      }),
    });
    log?.("info", "complexity_bumped", { taskId: task.id, base, bump, newScore });
    // Update in-memory task so selectBackend() sees the new score immediately.
    if (!task.metadata) task.metadata = {};
    task.metadata.effective_complexity = newScore;
  } catch (err) {
    log?.("warn", "complexityBump_patch_error", { taskId: task.id, err: err.message });
  }

  return newScore;
}

// ── COST_TIER_RANK ─────────────────────────────────────────────────────────────
const COST_TIER_RANK = { local: 0, "local-remote": 1, api: 2 };

// ── getSystemState ─────────────────────────────────────────────────────────────
/**
 * Probe each ollama-type backend for its currently-loaded models (/api/ps).
 * Fail-open: a backend that doesn't respond gets an empty hot-model set.
 * @param {Array} backends — full backends array from backends.json
 * @returns {{ hotModels: Object<string, Set<string>> }}
 *   hotModels is keyed by backend id; value is Set of model id strings currently loaded.
 */
export async function getSystemState(backends) {
  const hotModels = {};
  await Promise.all(
    (backends || [])
      .filter(b => b.type === "ollama")
      .map(async b => {
        try {
          const res = await fetch(`${b.url}/api/ps`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) { hotModels[b.id] = new Set(); return; }
          const { models = [] } = await res.json();
          // Ollama /api/ps returns { models: [{ name, model, ... }] }
          // "name" includes the tag (e.g. "qwen2.5-coder:14b")
          hotModels[b.id] = new Set(models.map(m => m.name || m.model).filter(Boolean));
        } catch {
          hotModels[b.id] = new Set(); // fail-open
        }
      })
  );
  return { hotModels };
}

// ── selectBackend (T5 full impl) ───────────────────────────────────────────────
/**
 * Pick best backend + model for a task given persona routing preferences.
 *
 * Algorithm (three-layer routing, ADR adr-routing-abstraction-2026-05-14):
 *  1. Compute complexity via complexityEstimate() (respects effective_complexity bump).
 *  2. Determine if escalation is active (complexity >= escalation.complexity_threshold).
 *  3. Resolve target tier + candidate backend list from persona routing block.
 *  4. Filter out backends that exceed cost_ceiling or lack min_capabilities.
 *  5. Walk preferred_backends in priority order; for each:
 *     a. Find models of the target tier.
 *     b. Prefer hot model (already loaded per /api/ps) for zero warm-up.
 *     c. Among cold: prefer smallest for normal complexity, largest for escalated.
 *  6. Fall back to legacy OLLAMA_URL/MODEL env vars (with reason logged).
 *
 * @param {object}   task        — full task node
 * @param {object}   persona     — persona config (needs .routing block)
 * @param {Array}    backends    — array from backends.json
 * @param {object}   systemState — { hotModels } from getSystemState(); optional
 * @returns {{ backendUrl, model, options, _routing_meta }}
 */
export async function selectBackend(task, persona, backends, systemState = {}) {
  const complexity    = complexityEstimate(task);
  const routing       = persona?.routing || {};
  const { hotModels = {} } = systemState;

  // ── Escalation decision ────────────────────────────────────────────────────
  const escalation  = routing.escalation || {};
  const escalated   = escalation.complexity_threshold != null &&
    complexity >= escalation.complexity_threshold;

  const targetTier       = escalated
    ? (escalation.escalated_tier   || routing.preferred_tier || "large")
    : (routing.preferred_tier      || "medium");
  const candidateIds     = escalated
    ? (escalation.backends         || routing.preferred_backends || [])
    : (routing.preferred_backends  || []);
  const costCeiling      = routing.cost_ceiling || "api";
  const costCeilingRank  = COST_TIER_RANK[costCeiling] ?? 2;
  const minCaps          = new Set(routing.min_capabilities || []);

  // ── Build lookup map ───────────────────────────────────────────────────────
  const backendMap = Object.fromEntries((backends || []).map(b => [b.id, b]));

  // ── Eligibility check ──────────────────────────────────────────────────────
  function backendEligible(b) {
    if ((COST_TIER_RANK[b.cost_tier] ?? 99) > costCeilingRank) return false;
    if (minCaps.size > 0) {
      const bCaps = new Set(b.capabilities || []);
      for (const c of minCaps) if (!bCaps.has(c)) return false;
    }
    return true;
  }

  // ── Model selection within a backend ──────────────────────────────────────
  function pickModel(backend, tier, preferSmall) {
    const candidates = (backend.models || []).filter(m => m.tier === tier);
    if (!candidates.length) return null;

    const hot = hotModels[backend.id] || new Set();

    // Prefer already-loaded model (zero warm-up cost).
    const hotMatch = candidates.find(m => hot.has(m.id));
    if (hotMatch) return hotMatch;

    // Cold: sort by size_gb ascending; pick first (smallest) or last (largest).
    const sorted = [...candidates].sort((a, b) => (a.size_gb || 0) - (b.size_gb || 0));
    return preferSmall ? sorted[0] : sorted[sorted.length - 1];
  }

  // ── Walk preferred backends in priority order ──────────────────────────────
  for (const bid of candidateIds) {
    const backend = backendMap[bid];
    if (!backend) continue;
    if (!backendEligible(backend)) continue;

    const model = pickModel(backend, targetTier, !escalated);
    if (!model) continue;

    const hot = (hotModels[backend.id] || new Set()).has(model.id);
    return {
      backendUrl: backend.url,
      model:      model.id,
      apiShape:   backend.type === "openai_compat" ? "openai" : null,
      options:    {},
      _routing_meta: {
        complexity_estimate: complexity,
        backend_id:          backend.id,
        model_tier:          targetTier,
        escalated,
        hot,
        stub: false,
      },
    };
  }

  // ── Fallback: legacy env-var defaults ─────────────────────────────────────
  return {
    backendUrl: process.env.OLLAMA_URL || persona?.ollama_base_url || "http://10.50.50.11:11434",
    model:      process.env.MODEL      || persona?.ollama_model    || "qwen2.5-coder:14b",
    apiShape:   null,
    options:    {},
    _routing_meta: {
      complexity_estimate: complexity,
      target_tier:         targetTier,
      escalated,
      fallback_reason:     "no_matching_backend",
      stub:                false,
    },
  };
}
