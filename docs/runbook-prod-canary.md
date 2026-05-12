# kiss-dispatcher prod canary — runbook

Lives on 10310Aton. Single role canary (default: `doc`). 7-day soak per Story `dispatcher-canary-prod-aton-2026-05`.

## What's running

| component | where | what |
|---|---|---|
| `kiss-dispatcher@doc.service` | 10310Aton (systemd) | claim + execute Tasks with `role_hint=doc` and parent Story `assignee_id=prod-doc` |
| `kiss-dispatcher-pg` container | 10310Aton (docker) | dedicated PG 16 instance, loopback `127.0.0.1:5435`, db `dispatcher` |
| `kiss-prod-doc-aton` Worker node | Neo4j graph | identity record; heartbeats on each tick |

## How to check it's healthy

```bash
# from anywhere
curl -s http://10.77.77.2:3001/nodes?label=Worker | jq '.[] | select(.props.id == "kiss-prod-doc-aton") | {id, last_seen_at}'

# on Aton
sudo systemctl is-active kiss-dispatcher@doc.service
sudo journalctl -u kiss-dispatcher@doc.service --no-pager -n 30
sudo docker exec kiss-dispatcher-pg psql -U kissadmin -d dispatcher \
  -c "SELECT status, count(*) FROM dispatcher_runs GROUP BY status;"
```

## Soak success criteria (7d window from 2026-05-11)

- Zero stranded doc Tasks (status=doing with no Worker heartbeat in >2 minutes).
- Zero `dispatcher_runs` rows stuck at `doing` >15 min after `claimed_at` (excludes legitimate slow LLM runs).
- Worker heartbeat gaps < 90s during expected work windows.
- No `panic` / `unhandled` / `terminated` log lines.
- No prod incident attributed to the canary path.

## Rollback (≤60s)

```bash
sudo bash /opt/kiss-dispatcher/scripts/prod-canary-uninstall.sh
```

Legacy `agile-dispatcher` remains untouched and continues serving as the prod queue-snapshot SPA. Stopping the canary does NOT take any prod work down — there is no other executor, but doc work simply waits until the canary is restarted or a different executor takes over.

## Known issues (filed)

- `kiss-dispatcher-bug-auto-create-dispatcher-runs-schema-2026-05-11` — schema must be pre-created on a fresh PG (deploy script handles this).
- `kiss-dispatcher-bug-stuck-doing-on-handler-error-2026-05-11` — when the role handler throws, the agile Task is not PATCHed back to a clean terminal state. Operator must manually cancel/release.

## After the soak

- Pass: cut over remaining roles via `dispatcher-cutover-prod-2026-05`, then decom legacy via `dispatcher-decom-old-2026-05`.
- Fail: file a Decision under this Story explaining the failure mode + remediation plan; rollback to legacy-only.
