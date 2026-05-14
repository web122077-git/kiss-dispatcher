import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

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

// ── Gate patterns: load file_write_blocked_prefixes from shared JSON ──────
// Path: $GATE_PATTERNS_PATH or kiss-dispatcher/gate-patterns.json (one level up from src/).
// Fail-open: falls back to hardcoded list if file is missing or unparseable.
const _HARDCODED_BLOCKED_PREFIXES = [
  "/etc/", "/boot/", "/sys/", "/proc/", "/dev/",
  "/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/",
];
function _loadFileWriteBlockedPrefixes() {
  const p = process.env.GATE_PATTERNS_PATH ||
    new URL("../gate-patterns.json", import.meta.url).pathname;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const list = data.file_write_blocked_prefixes;
    if (Array.isArray(list) && list.length) return list;
  } catch (_) { /* fall through */ }
  return _HARDCODED_BLOCKED_PREFIXES;
}
const FILE_WRITE_BLOCKED_PREFIXES = _loadFileWriteBlockedPrefixes();


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

  // ── Write-tier tools — require explicit approval before execution ─────────
  // x-requires-explicit-approval: true causes executeTool to file an
  // ApprovalRequest node and return { ok:false, approval_pending:true }
  // instead of executing the tool. The Cabinet polls /approvals/pending and
  // surfaces Allow-once / Allow-always / Deny buttons.
  // Story: permission-request-ui-track2-allowlists-2026-05
  agile_node_create: {
    type: "function",
    "x-requires-explicit-approval": true,
    function: {
      name: "agile_node_create",
      description: "Create an agile node (epic/story/task/decision/ticket/blocker) on the board. Use after read tools confirm the item does not already exist. Requires explicit approval.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", enum: ["epic","story","task","decision","ticket","blocker"], description: "Node type" },
          body:  { type: "object", description: "Full payload for POST /agile/<label> — must include id and title at minimum" }
        },
        required: ["label","body"]
      }
    }
  },
  agile_node_patch: {
    type: "function",
    "x-requires-explicit-approval": true,
    function: {
      name: "agile_node_patch",
      description: "Update or transition an agile node (status change, field update). Requires explicit approval.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", enum: ["epic","story","task","decision","ticket","blocker"] },
          id:    { type: "string" },
          patch: { type: "object", description: "Fields to PATCH. For status transitions include {status} and {resolution} if done/resolved." }
        },
        required: ["label","id","patch"]
      }
    }
  },
  file_write: {
    type: "function",
    "x-requires-explicit-approval": true,
    function: {
      name: "file_write",
      description: "Write or overwrite a file under /10310L/repos/. Always call file_read first. Requires explicit approval.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "Absolute path under /10310L/repos/" },
          content: { type: "string", description: "Full file content to write" },
          mode:    { type: "string", enum: ["overwrite","append"], default: "overwrite" }
        },
        required: ["path","content"]
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
    // openclaw is a peer persona (Story:openclaw-as-peer-persona-2026-05-12). The dispatcher
    // calls the gateway like any other Ollama endpoint; the gateway has its own agent loop +
    // tools, so we only inject lightweight read tools here so the dispatcher's ollama.mjs path
    // works without a tool-shape error. Effective allow-list is small on purpose.
    openclaw: ["xray","nodes_q","host","service","file_read","file_tree"],
  };
  // Write-tier additions — all behind the approval gate in executeTool.
  base.cpm    = [...base.cpm,    "agile_node_create","agile_node_patch"];
  base.pm     = [...base.pm,     "agile_node_create","agile_node_patch"];
  base.tl     = [...base.tl,     "agile_node_patch"];
  base.be     = [...base.be,     "agile_node_patch","file_write"];
  base.fe     = [...base.fe,     "agile_node_patch","file_write"];
  base.do     = [...base.do,     "agile_node_patch","file_write"];
  base.doc    = [...base.doc,    "file_write"];
  base.closer = [...base.closer, "agile_node_create","agile_node_patch"];
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

  // Write-tier executors — only reached after approval gate passes.
  agile_node_create: async ({ label, body }) => {
    const r = await fetch(`${CTX_API}/agile/${encodeURIComponent(label)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json().catch(() => ({ ok: r.ok, status: r.status }));
  },
  agile_node_patch: async ({ label, id, patch }) => {
    const r = await fetch(`${CTX_API}/agile/${encodeURIComponent(label)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return r.json().catch(() => ({ ok: r.ok, status: r.status }));
  },
  file_write: async ({ path: p, content, mode = "overwrite" }) => {
    const { writeFile, appendFile } = await import("node:fs/promises");
    const abs = path.resolve(p);
    // ── Path gate — block writes to system directories ──────────────────────
    // Mirrors BLOCK_PATTERNS in bash-gate.py. Fail-open: errors allow.
    // Story: destructive-command-gate-spike-2026-05-13
    for (const prefix of FILE_WRITE_BLOCKED_PREFIXES) {
      if (abs.startsWith(prefix)) {
        return { ok: false, error: `file_write to ${prefix}* is blocked — system path` };
      }
    }
    if (!abs.startsWith(FILE_READ_ROOT)) return { ok: false, error: `path outside ${FILE_READ_ROOT}` };
    if (mode === "append") { await appendFile(abs, content, "utf8"); }
    else { await writeFile(abs, content, "utf8"); }
    return { ok: true, path: abs, bytes: content.length };
  },
};

// Result size cap to protect downstream prompts.
const TOOL_RESULT_CHAR_CAP = 6000;

// executeTool now takes an optional roleHint and enforces the allow-list.
// Back-compat: if roleHint is omitted (or unknown), the role gate is skipped
// and the executor is dispatched on TOOL_EXECUTORS lookup alone — same as
// pre-T4 behavior. The dispatcher passes ROLE_HINT from env in production.
// Derived once at module load — O(1) membership check per tool call.
const APPROVAL_REQUIRED_TOOLS = new Set(
  Object.entries(TOOL_SCHEMAS)
    .filter(([, s]) => s?.["x-requires-explicit-approval"] === true)
    .map(([name]) => name)
);

// executeTool(name, args, roleHint, taskId)
// taskId is the currently-executing Task id (for ApprovalRequest provenance).
// Back-compat: taskId defaults to null; approval requests still work without it.
export async function executeTool(name, args, roleHint, taskId = null) {
  if (roleHint && ROLE_TOOLS[roleHint] && !ROLE_TOOLS[roleHint].includes(name)) {
    return JSON.stringify({ ok: false, error: `tool ${name} not in allow-list for role ${roleHint}` });
  }
  // ── Approval gate — write-tier tools short-circuit until a grant exists ───
  // Story: permission-request-ui-track2-allowlists-2026-05
  if (APPROVAL_REQUIRED_TOOLS.has(name)) {
    let check = null;
    try {
      const cr = await fetch(
        `${CTX_API}/approvals/check?tool=${encodeURIComponent(name)}&role=${encodeURIComponent(roleHint || "")}`
      );
      if (cr.ok) check = await cr.json();
    } catch (_) { /* context-api unreachable — treat as no grant */ }

    if (!check?.granted) {
      // File a pending request so the Cabinet can surface it.
      let reqId = `apr-err-${Date.now()}`;
      try {
        const rr = await fetch(`${CTX_API}/approvals/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool_name: name,
            args_json: JSON.stringify(args || {}),
            role: roleHint || "",
            requester_task_id: taskId || "",
          }),
        });
        if (rr.ok) { const rb = await rr.json(); reqId = rb.id || reqId; }
      } catch (_) { /* fire-and-forget: approval filing failure must not crash the worker */ }
      return JSON.stringify({
        ok: false,
        approval_pending: true,
        approval_id: reqId,
        message: `Tool '${name}' requires explicit approval. Request filed as ${reqId}. Open Cabinet (/cabinet) to Allow or Deny.`,
      });
    }
    // Grant exists: if allow_once, consume it best-effort (non-fatal).
    if (check.status === "allowed_once" && check.approval_id) {
      fetch(`${CTX_API}/approvals/${encodeURIComponent(check.approval_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "consumed" }),
      }).catch(() => {});
    }
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
