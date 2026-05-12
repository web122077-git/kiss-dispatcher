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
      description: "Submit an async chat request via OpenClaw (self-hosted Claude.ai bridge). Returns a task_id immediately; poll openclaw_task_status to get the result. Use when a Task needs the Claude.ai chat surface (web search, MCP-equipped Claude conversation, agentic tool use) rather than the local Ollama model.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message to send to OpenClaw / Claude." },
          session_id: { type: "string", description: "Optional session id to thread the message into an existing conversation." },
          priority: { type: "number", description: "Task priority (higher = processed first). Default: 0." },
          instance: { type: "string", description: "Optional OpenClaw instance name. Defaults to the configured default instance." }
        },
        required: ["message"]
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
// Full OAuth 2.1 PKCE + MCP HTTP transport. The freema/openclaw-mcp bridge
// has AUTH_ENABLED=true and only advertises authorization_code/refresh_token
// grants — so a backend caller has to do the PKCE handshake even though
// nobody types a password. Once we hold a bearer token, MCP requires:
//   1. POST /mcp { method:'initialize' } → response carries Mcp-Session-Id
//   2. POST /mcp { method:'notifications/initialized' } on that session
//   3. POST /mcp { method:'tools/call', params:{name, arguments} } on that session
//
// We memoize the token+session at module scope so subsequent tool_calls in a
// single Ollama loop reuse them. On 401 we drop and re-auth once.

import { createHash, randomBytes } from "node:crypto";

const OPENCLAW_TIMEOUT_MS = 30_000;
const REDIRECT_URI = "http://localhost/cb";

let _ocToken = null;
let _ocSession = null;
let _ocInitPromise = null;

function _b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function _ocGetToken(url) {
  const clientId = process.env.OPENCLAW_MCP_CLIENT_ID || "openclaw";
  const clientSecret = process.env.OPENCLAW_MCP_CLIENT_SECRET || "";
  if (!clientSecret) throw new Error("OPENCLAW_MCP_CLIENT_SECRET unset");

  const verifier = _b64url(randomBytes(48));
  const challenge = _b64url(createHash("sha256").update(verifier).digest());

  // Step 1: POST /authorize → 302 with ?code=...
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:tools",
  });
  const authResp = await fetch(`${url}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: authParams.toString(),
    redirect: "manual",
  });
  const loc = authResp.headers.get("location") || "";
  const m = loc.match(/[?&]code=([^&]+)/);
  if (!m) throw new Error(`no auth code in redirect; loc=${loc.slice(0,200)} status=${authResp.status}`);
  const code = decodeURIComponent(m[1]);

  // Step 2: POST /token → access_token
  const tokParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokResp = await fetch(`${url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokParams.toString(),
  });
  const tokJson = await tokResp.json().catch(() => null);
  if (!tokJson || !tokJson.access_token) throw new Error(`token grant failed: ${JSON.stringify(tokJson)}`);
  return tokJson.access_token;
}

async function _ocInitSession(url, token) {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  const initResp = await fetch(`${url}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "kiss-dispatcher", version: "0.1" },
      },
    }),
  });
  const session = initResp.headers.get("mcp-session-id");
  if (!session) {
    const body = (await initResp.text()).slice(0, 400);
    throw new Error(`no Mcp-Session-Id in init response: ${body}`);
  }
  await initResp.text().catch(() => null); // drain

  // notifications/initialized — required by MCP spec before any other call
  await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": session },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  return session;
}

async function _ocEnsureSession(url) {
  if (_ocToken && _ocSession) return { token: _ocToken, session: _ocSession };
  if (_ocInitPromise) return _ocInitPromise;
  _ocInitPromise = (async () => {
    const token = await _ocGetToken(url);
    const session = await _ocInitSession(url, token);
    _ocToken = token;
    _ocSession = session;
    return { token, session };
  })();
  try { return await _ocInitPromise; }
  finally { _ocInitPromise = null; }
}

function _parseMcpResponse(text) {
  // openclaw-mcp returns SSE-shaped 'event: message\ndata: {...}'. Handle both
  // SSE and plain JSON for portability.
  if (text && /^event:|\ndata:/.test(text)) {
    const m = text.match(/data:\s*(\{[\s\S]*\})/);
    if (m) { try { return JSON.parse(m[1]); } catch (_) { /* fall through */ } }
  }
  try { return JSON.parse(text); } catch (_) { return null; }
}

async function openclawMcpCall(toolName, args, retry = 1) {
  const url = (process.env.OPENCLAW_MCP_URL || "").replace(/\/$/, "");
  if (!url) return { ok: false, error: "openclaw not configured (OPENCLAW_MCP_URL unset)" };

  let sess;
  try {
    sess = await _ocEnsureSession(url);
  } catch (e) {
    return { ok: false, error: `openclaw auth failed: ${e.message || String(e)}` };
  }

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort("openclaw-mcp timeout"), OPENCLAW_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${sess.token}`,
        "Mcp-Session-Id": sess.session,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "tools/call",
        params: { name: toolName, arguments: args || {} },
      }),
      signal: ctrl.signal,
    });
    if ((r.status === 401 || r.status === 404) && retry > 0) {
      // token expired / session evicted — drop and retry once
      _ocToken = null;
      _ocSession = null;
      return openclawMcpCall(toolName, args, retry - 1);
    }
    if (!r.ok) {
      const text = (await r.text()).slice(0, 400);
      return { ok: false, status: r.status, error: `openclaw-mcp HTTP ${r.status}`, body: text };
    }
    const text = await r.text();
    const payload = _parseMcpResponse(text);
    if (!payload) return { ok: false, error: "unparseable openclaw response", body: text.slice(0, 400) };
    if (payload.error) return { ok: false, error: payload.error.message || String(payload.error), code: payload.error.code };
    return { ok: true, result: payload.result || null };
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
