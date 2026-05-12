// Read-only context-api + file tools available to all personas in Phase 2 T2a.
// Per decision-tools-per-role-not-batch-2026-05-11: read tools inline; write/external
// tools (svc-ansible-ssh, openbao, openclaw, file-write) stay in Phase 4 Track 2.
//
// Phase 4 Track 2 first lander (T4 of openclaw-spike-zdev-2026-05, 2026-05-11):
// openclaw_chat_async / openclaw_task_status / openclaw_task_cancel are added
// to the DO persona's allow-list when OPENCLAW_MCP_URL is set in env. Prod
// DO workers (no env) advertise the original tool set unchanged.

const CTX_API = (process.env.CTX_API || "http://10.77.77.2:3001").replace(/\/$/, "");
const FILE_READ_ROOT = process.env.FILE_READ_ROOT || "/10310L/repos";

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Tool descriptors in OpenAI function-calling format (Ollama-compatible).
export const TOOL_SCHEMAS = {
  // graph-read tools
  xray: {
    type: "function",
    function: {
      name: "xray",
      description: "Fuzzy-match a node in the homelab knowledge graph and return its neighborhood. USE THIS before asserting any infra fact (host IPs, service ports, container locations).",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    }
  },
  nodes_q: {
    type: "function",
    function: {
      name: "nodes_q",
      description: "Search graph nodes by name substring or label.",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
    }
  },
  host: {
    type: "function",
    function: {
      name: "host",
      description: "Deep-dive on a single Host node — its containers, services, NICs, GPUs.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    }
  },
  service: {
    type: "function",
    function: {
      name: "service",
      description: "Inspect a Service node — its host, port, dependencies, recent status.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    }
  },
  logs: {
    type: "function",
    function: {
      name: "logs",
      description: "Recent graph audit log entries (writes by all sessions).",
      parameters: { type: "object", properties: { limit: { type: "integer", default: 20 } } }
    }
  },
  // decision-read
  decision_recent: {
    type: "function",
    function: {
      name: "decision_recent",
      description: "List recently accepted Decisions on the agile board.",
      parameters: { type: "object", properties: { limit: { type: "integer", default: 20 } } }
    }
  },
  decision_get: {
    type: "function",
    function: {
      name: "decision_get",
      description: "Fetch a single Decision by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  // agile-list (lets CPM/PM see existing work before filing)
  agile_epic_list: {
    type: "function",
    function: {
      name: "agile_epic_list",
      description: "List Epics on the agile board, optionally filtered by status (default: active).",
      parameters: { type: "object", properties: { status: { type: "string", default: "active" } } }
    }
  },
  agile_epic_get: {
    type: "function",
    function: {
      name: "agile_epic_get",
      description: "Fetch a single Epic by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  agile_story_list_by_epic: {
    type: "function",
    function: {
      name: "agile_story_list_by_epic",
      description: "List Stories under a parent Epic.",
      parameters: { type: "object", properties: { epic_id: { type: "string" } }, required: ["epic_id"] }
    }
  },
  agile_story_get: {
    type: "function",
    function: {
      name: "agile_story_get",
      description: "Fetch a single Story by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  agile_task_list_by_story: {
    type: "function",
    function: {
      name: "agile_task_list_by_story",
      description: "List Tasks under a parent Story.",
      parameters: { type: "object", properties: { story_id: { type: "string" } }, required: ["story_id"] }
    }
  },
  agile_task_get: {
    type: "function",
    function: {
      name: "agile_task_get",
      description: "Fetch a single Task by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  // file-read (BE/FE/DO/DOC need this for read-before-write)
  file_read: {
    type: "function",
    function: {
      name: "file_read",
      description: "Read a file under /10310L/repos/ by absolute path. Use this to ground your work in actual source before writing.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  file_tree: {
    type: "function",
    function: {
      name: "file_tree",
      description: "List entries in a directory under /10310L/repos/.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  // openclaw doer-surface tools (Phase 4 Track 2, T4 of openclaw-spike-zdev-2026-05).
  // Gated by OPENCLAW_MCP_URL env — only DO workers with the env set advertise these.
  openclaw_chat_async: {
    type: "function",
    function: {
      name: "openclaw_chat_async",
      description: "Submit an async chat request via OpenClaw (self-hosted Claude.ai bridge). Returns a task_id; poll openclaw_task_status until done. Use when a Task needs the Claude.ai chat surface (web search, MCP-equipped Claude conversation, agentic tool use) rather than the local Ollama model.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The chat prompt to send to Claude.ai via OpenClaw." },
          target: { type: "string", description: "Optional chat target id (project/conversation). Omit for default." },
          model: { type: "string", description: "Optional model override (e.g. 'claude-opus-4-6'). Omit for default." }
        },
        required: ["prompt"]
      }
    }
  },
  openclaw_task_status: {
    type: "function",
    function: {
      name: "openclaw_task_status",
      description: "Get the status + result of a previously-submitted OpenClaw async task. Call after openclaw_chat_async returns a task_id.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"]
      }
    }
  },
  openclaw_task_cancel: {
    type: "function",
    function: {
      name: "openclaw_task_cancel",
      description: "Cancel an in-flight OpenClaw async task. Use if the run is no longer needed or hangs.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"]
      }
    }
  },
};

// Per-role tool allow-lists (mirrors personas.v7.json tool_catalog).
// Roles get exactly what their v7 entry says, NOT the full set.
//
// buildRoleTools(env) layers env-gated additions on top of the static catalog.
// Tests assert the gating behavior by calling this directly; the runtime
// export `ROLE_TOOLS` below evaluates the env once at module load.
export function buildRoleTools(env) {
  const base = {
    cpm:    ["xray","nodes_q","host","service","logs","decision_recent","decision_get","agile_epic_list","agile_epic_get","agile_story_list_by_epic","agile_story_get","agile_task_list_by_story","agile_task_get"],
    pm:     ["xray","nodes_q","host","service","logs","decision_recent","decision_get","agile_epic_get","agile_story_list_by_epic","agile_story_get","agile_task_list_by_story"],
    tl:     ["xray","nodes_q","host","service","logs","file_read","file_tree","decision_recent","decision_get"],
    be:     ["xray","nodes_q","host","service","file_read","file_tree"],
    fe:     ["xray","nodes_q","host","service","file_read","file_tree"],
    do:     ["xray","nodes_q","host","service","logs","file_read","file_tree"],   // file-read added 2026-05-11 (v7 oversight)
    qa:     ["xray","nodes_q","host","service","file_read"],                       // file-read constrained: only for citation-substantiation per Chet
    doc:    ["file_read","file_tree","decision_recent","decision_get"],
    closer: ["xray","decision_recent","decision_get","agile_epic_get","agile_story_get","agile_task_get"],
  };
  // Phase 4 Track 2: DO gets openclaw_* tools when OPENCLAW_MCP_URL is set.
  // Prod DO workers (env unset) keep the original allow-list unchanged.
  if (env && env.OPENCLAW_MCP_URL && String(env.OPENCLAW_MCP_URL).length > 0) {
    base.do = [...base.do, "openclaw_chat_async", "openclaw_task_status", "openclaw_task_cancel"];
  }
  return base;
}

export const ROLE_TOOLS = buildRoleTools(process.env);

export function toolsForRole(roleHint) {
  const names = ROLE_TOOLS[roleHint];
  if (!names) throw new Error(`unknown role_hint: ${roleHint}`);
  return names.map(n => {
    if (!TOOL_SCHEMAS[n]) throw new Error(`tool ${n} missing schema`);
    return TOOL_SCHEMAS[n];
  });
}

// ── Tool executors ───────────────────────────────────────────────────────
async function ctxGet(suffix) {
  const r = await fetch(`${CTX_API}${suffix}`);
  if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 400) };
  const j = await r.json().catch(() => null);
  return j ?? { ok: true };
}

const FILE_MAX_BYTES = 64 * 1024;

async function fileRead(p) {
  const abs = path.resolve(p);
  if (!abs.startsWith(FILE_READ_ROOT)) return { ok: false, error: `path outside ${FILE_READ_ROOT}: ${abs}` };
  const s = await stat(abs).catch(() => null);
  if (!s) return { ok: false, error: `not found: ${abs}` };
  if (s.isDirectory()) return { ok: false, error: `is a directory; use file_tree: ${abs}` };
  if (s.size > FILE_MAX_BYTES) return { ok: false, error: `file too large (${s.size} > ${FILE_MAX_BYTES})`, hint: `truncated_path_or_chunk` };
  const body = await readFile(abs, "utf8");
  return { ok: true, path: abs, size: s.size, body: body.slice(0, FILE_MAX_BYTES) };
}

async function fileTree(p) {
  const abs = path.resolve(p);
  if (!abs.startsWith(FILE_READ_ROOT)) return { ok: false, error: `path outside ${FILE_READ_ROOT}: ${abs}` };
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => null);
  if (!entries) return { ok: false, error: `not found: ${abs}` };
  return { ok: true, path: abs, entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })) };
}

// ── OpenClaw MCP bridge call ────────────────────────────────────────────
// Stateless POST to ${OPENCLAW_MCP_URL}/mcp using MCP HTTP transport
// (JSON-RPC 2.0, method=tools/call). Bearer token from OPENCLAW_MCP_TOKEN.
// If OPENCLAW_MCP_URL is unset, returns a configured-no error rather than
// crashing — defensive against an OPENCLAW_MCP_URL-less DO worker (which
// should not be calling these tools, but kiss-dispatcher avoids hard fails
// on env drift).
const OPENCLAW_TIMEOUT_MS = 30_000;

async function openclawMcpCall(toolName, args) {
  const url = (process.env.OPENCLAW_MCP_URL || "").replace(/\/$/, "");
  const token = process.env.OPENCLAW_MCP_TOKEN || "";
  if (!url) return { ok: false, error: "openclaw not configured (OPENCLAW_MCP_URL unset)" };

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const body = {
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method: "tools/call",
    params: { name: toolName, arguments: args || {} },
  };

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort("openclaw-mcp timeout"), OPENCLAW_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 400);
      return { ok: false, status: r.status, error: `openclaw-mcp HTTP ${r.status}`, body: text };
    }
    const j = await r.json().catch(() => null);
    if (j && j.error) return { ok: false, error: j.error.message || String(j.error), code: j.error.code };
    return { ok: true, result: j ? j.result : null };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(tm);
  }
}

export const TOOL_EXECUTORS = {
  xray:    ({ name }) => ctxGet(`/xray/${encodeURIComponent(name)}`),
  nodes_q: ({ q })    => ctxGet(`/nodes?q=${encodeURIComponent(q)}`),
  host:    ({ name }) => ctxGet(`/host/${encodeURIComponent(name)}`),
  service: ({ name }) => ctxGet(`/service/${encodeURIComponent(name)}`),
  logs:    ({ limit = 20 }) => ctxGet(`/logs?limit=${limit}`),
  decision_recent:           ({ limit = 20 }) => ctxGet(`/agile/decision?status=accepted&limit=${limit}`),
  decision_get:              ({ id })         => ctxGet(`/agile/decision/${encodeURIComponent(id)}`),
  agile_epic_list:           ({ status = "active" }) => ctxGet(`/agile/epic?status=${status}`),
  agile_epic_get:            ({ id })         => ctxGet(`/agile/epic/${encodeURIComponent(id)}`),
  agile_story_list_by_epic:  ({ epic_id })    => ctxGet(`/agile/story?parent_id=${encodeURIComponent(epic_id)}`),
  agile_story_get:           ({ id })         => ctxGet(`/agile/story/${encodeURIComponent(id)}`),
  agile_task_list_by_story:  ({ story_id })   => ctxGet(`/agile/task?parent_id=${encodeURIComponent(story_id)}`),
  agile_task_get:            ({ id })         => ctxGet(`/agile/task/${encodeURIComponent(id)}`),
  file_read:                 ({ path: p })    => fileRead(p),
  file_tree:                 ({ path: p })    => fileTree(p),
  openclaw_chat_async:       (a)              => openclawMcpCall("openclaw_chat_async", a),
  openclaw_task_status:      (a)              => openclawMcpCall("openclaw_task_status", a),
  openclaw_task_cancel:      (a)              => openclawMcpCall("openclaw_task_cancel", a),
};

// Result size cap to protect downstream prompts.
const TOOL_RESULT_CHAR_CAP = 6000;

// executeTool now takes an optional roleHint and enforces the allow-list.
// Back-compat: if roleHint is omitted (or unknown), the role gate is skipped
// and the executor is dispatched on TOOL_EXECUTORS lookup alone — same as
// pre-T4 behavior. The dispatcher passes ROLE_HINT from env in production.
export async function executeTool(name, args, roleHint) {
  if (roleHint && ROLE_TOOLS[roleHint] && !ROLE_TOOLS[roleHint].includes(name)) {
    return JSON.stringify({ ok: false, error: `tool ${name} not in allow-list for role ${roleHint}` });
  }
  const fn = TOOL_EXECUTORS[name];
  if (!fn) return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
  try {
    const out = await fn(args || {});
    let s = JSON.stringify(out);
    if (s.length > TOOL_RESULT_CHAR_CAP) s = s.slice(0, TOOL_RESULT_CHAR_CAP) + ' …[truncated]';
    return s;
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message || String(e) });
  }
}
