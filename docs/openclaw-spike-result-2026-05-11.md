# OpenClaw Spike Result — T6 of openclaw-spike-zdev-2026-05

**Date:** 2026-05-11 (cowork session)
**Branch:** Phase 0 of `local-llm-team-stitch-2026-05` Epic
**Status:** Spike complete. Deployment shape + auth surface documented below. Two real follow-up Tasks filed under the spike Story (`openclaw-spike-do-prompt-blocks-tool-calls-2026-05-11`, `openclaw-spike-gateway-default-model-ignored-2026-05-11`). Input to `decision-openclaw-deployment-pattern-2026-05`.

## Deployment topology

```
zdev-trigger LXC (10.98.98.34, vmid 259)
  └── kiss-dispatcher@<role>.service × 9   (systemd template units)
        └── role=do reads do.env →
              OPENCLAW_MCP_URL=http://10.98.98.33:3000
              OPENCLAW_MCP_CLIENT_ID=openclaw
              OPENCLAW_MCP_CLIENT_SECRET=<from Bao secret/services/openclaw-zdev>
              OPENCLAW_MCP_TOKEN=         (legacy slot, unused — auth is OAuth)

zdev-openclaw LXC (10.98.98.33, vmid 258)
  ├── openclaw           container — port 18789 (gateway, OpenAI-compatible /v1/chat/completions)
  │     mounts: /opt/openclaw/openclaw.json → /etc/openclaw/openclaw.json
  │     env:   OPENCLAW_GATEWAY_TOKEN=<from Bao>
  │     volume: openclaw-data (persistent gateway state)
  └── openclaw-mcp       container — port 3000 (freema/openclaw-mcp, OAuth-secured MCP bridge)
        env:   OPENCLAW_URL=http://openclaw:18789
               OPENCLAW_GATEWAY_TOKEN=<same as gateway>
               AUTH_ENABLED=true
               MCP_CLIENT_ID=openclaw
               MCP_CLIENT_SECRET=<from Bao>
               CORS_ORIGINS=https://claude.ai,http://10.77.77.2:3001
        flags: read_only, no-new-privileges
```

## Auth surface

Three distinct token surfaces, all sourced from OpenBao `secret/services/openclaw-zdev`:

1. **Gateway token (`OPENCLAW_GATEWAY_TOKEN`)** — symmetric secret shared between openclaw and openclaw-mcp containers. Authenticates the MCP bridge to the upstream gateway. Not consumed by dispatcher.

2. **MCP client credentials (`MCP_CLIENT_ID` + `MCP_CLIENT_SECRET`)** — OAuth 2.1 client registration for the bridge's `/authorize` and `/token` endpoints. The bridge advertises `authorization_code` and `refresh_token` grants only; `client_credentials` is rejected (`unsupported_grant_type`). A backend caller (kiss-dispatcher) therefore has to PKCE-handshake even though no human types a password — the bridge accepts the auth-code grant without an interactive consent screen.

3. **MCP bearer + session** — the dispatcher executor exchanges client creds → access_token, then `POST /mcp initialize` → response carries `Mcp-Session-Id`. Subsequent `tools/call` invocations require both `Authorization: Bearer <token>` AND `Mcp-Session-Id: <session>`. `notifications/initialized` must be sent on the session before any `tools/call` (MCP 2025-06-18 spec).

### kiss-dispatcher implementation (src/tools.mjs)

- `_ocGetToken` — PKCE handshake (POST /authorize → 302 with `?code=`, then POST /token with code_verifier).
- `_ocInitSession` — initialize → captures `Mcp-Session-Id` → notifications/initialized.
- `_ocEnsureSession` — module-scope memo, serialized init via shared promise. Token + session cached for process lifetime.
- `openclawMcpCall(name, args, retry=1)` — POST /mcp tools/call. On 401/404, drop cached creds and re-auth once. Parses both `event: message\ndata: {...}` SSE shape and plain JSON.

## Graph changes (already in place)

```
(LXC:zdev-openclaw {ip:10.98.98.33, vmid:258, environment:zdev, vlan:98})
  ← RUNS_ON ← (Service:OpenClaw Gateway {port:18789, protocol:http})
  ← RUNS_ON ← (Service:OpenClaw MCP Bridge {port:3000, protocol:http})

(LXC:zdev-trigger {ip:10.98.98.34, vmid:259})
  ← RUNS_ON ← (Service:kiss-dispatcher {repo:kiss-dispatcher, deployed_path:/opt/kiss-dispatcher})
```

(No new edges to add. The dispatcher's openclaw consumption is config-driven via env vars; no MANAGES edge needed.)

## Allow-list shape

Per `decision-tools-per-role-not-batch-2026-05-11` and `tools.mjs.buildRoleTools(env)`:

- When `OPENCLAW_MCP_URL` is set on a worker's env, that worker's role's allow-list is extended.
- T4 enabled this for DO only. Other roles' envs do not have OPENCLAW_MCP_URL.
- Allow-list enforcement is bi-modal: (a) the model only SEES tools in its catalog (so well-behaved models never call them), and (b) `executeTool(name, args, roleHint)` rejects out-of-list calls server-side with `{ok:false, error:'tool X not in allow-list for role Y'}`.

## Single-instance vs multi-instance recommendation

**Recommend single-instance on zdev for now.** Reasons:

- OpenClaw gateway state is in `openclaw-data` volume — one container per instance is the natural unit. Scaling out across instances would require a shared backing store or session affinity to the same instance, neither of which is set up.
- The MCP bridge is stateless once auth+session lands; multiple bridges fronting the same gateway are fine but offer no benefit at this load.
- The dispatcher already memoizes the bridge token + session per-worker-process — every DO worker would establish its own session, no need to fan-out across multiple bridges.

If a prod-tier deployment is greenlit, **add a per-tenant instance suffix** to `OPENCLAW_MCP_URL` so prod-do hits prod-openclaw and zdev-do hits zdev-openclaw — no shared state across tiers.

## Gotchas surfaced during spike

1. **Bridge advertises only authorization_code grant.** Backend callers can't use the simpler `client_credentials` path. The PKCE flow against `/authorize` works without interactive consent — confirmed against the freema/openclaw-mcp 1.4.1 image, but is non-obvious from the OAuth metadata response.

2. **MCP HTTP transport requires session affinity.** A stateless POST of `tools/call` returns `Server not initialized`. Each session is keyed by `Mcp-Session-Id` returned from the initialize response and must receive `notifications/initialized` before any other call.

3. **MCP responses are SSE-shaped** (`event: message\ndata: {...}`). A pure-JSON parser will throw. Handle both shapes.

4. **MCP tool schema vs. our descriptor.** Real tool name is `openclaw_chat_async` (matches) but argument is `message`, not `prompt`. Other args: `session_id`, `priority`, `instance` (all optional). Initial v1 schemas used `prompt` — caught + fixed in b7ee4bb.

5. **DO prompt suppresses tool_calls.** `kiss-dispatcher/src/prompts.mjs` `buildImplementerPrompt` forces "First line: acceptance criteria as I read them..." → diff → JSON. qwen2.5-coder:14b emits the narrative and stops, not calling any tool. Wiring is correct (manual `executeTool` returns a valid task_id); the bottleneck is prompt design. Filed as `openclaw-spike-do-prompt-blocks-tool-calls-2026-05-11`.

6. **OpenClaw gateway resolves agent.defaultModel incorrectly.** Config file mounts correctly and reads `zdev-ollama1/qwen2.5:0.5b`, but boot log says `agent model: ollama/llama3.2:1b` (a built-in default). Submissions fail with `API request failed: 404 Not Found`. Filed as `openclaw-spike-gateway-default-model-ignored-2026-05-11`.

7. **context-api `/agile/task/claim` half-commits when Worker node missing.** Surfaced while probing the claim filter. The SET t.status=doing runs before the `MATCH (w:Worker)` clause; a probe with a non-existent worker_id leaves the Task in status=doing with no `WORKING_ON` edge. Filed as `context-api-claim-half-commit-on-missing-worker-2026-05-11`.

## Acceptance for T6

Note tagged `spike-result` + `openclaw` at /notes. Input to `decision-openclaw-deployment-pattern-2026-05`.
