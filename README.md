# kiss-dispatcher

KISS PG advisory-lock dispatcher for the 10310 homelab local-LLM agile team. Replaces the legacy `agile-dispatcher` service per [`decision-dispatcher-replace-choice-2026-05-11`](http://10.77.77.2:3001/agile/decision/decision-dispatcher-replace-choice-2026-05-11) (accepted).

Lifted and generalized from the Phase 0 spike at [`infra-graph/spikes/kiss-loop-dispatcher`](https://github.com/web122077-git/infra-graph/tree/main/spikes/kiss-loop-dispatcher).

## What this is

One TypeScript-flavored ES module that:
1. Polls `GET /agile/task?status=todo` on the homelab Context API (default `http://10.77.77.2:3001`).
2. Filters candidates by **role_hint** AND **parent Story `assignee_id` == `WORKER_ASSIGNEE_ID`** (per [`decision-assignee-id-as-tenancy-discipline-2026-05-11`](http://10.77.77.2:3001/agile/decision/decision-assignee-id-as-tenancy-discipline-2026-05-11)).
3. For each candidate: acquires `pg_try_advisory_xact_lock(hashtext(task_id))` in a short tx, writes a `dispatcher_runs` row at status=`doing`, commits.
4. PATCHes the Task to `doing` on the agile board.
5. Runs the role-specific Ollama call (model + system prompt loaded from `personas.v7.json`).
6. PATCHes the Task to `done` with the resolution.
7. UPDATEs the `dispatcher_runs` row to status=`done` in a separate tx.

Any failure between steps 4 and 6 marks `dispatcher_runs` row as `failed` via a separate tx.

## Architecture invariants (must hold)

- **One worker per task at a time.** Enforced by `pg_try_advisory_xact_lock(hashtext(task_id))`.
- **No reopens of done tasks.** Status re-check after lock acquire; skip if `status != "todo"`.
- **No split-brain.** Two-phase write — `dispatcher_runs` row exists from claim time; agile PATCH happens between tx1 (claim+record) and tx2 (finish).
- **Tenancy isolation.** Workers only claim Tasks under Stories whose `assignee_id == WORKER_ASSIGNEE_ID`. Prod and zdev workers cannot step on each other's queues even though the board is shared.

## Deploying

Phase 2 (zdev): 9 systemd unit instances on `zdev-trigger`, one per role.
Phase 3 (prod): canary one role through, soak 7 days, cut over, decom legacy `agile-dispatcher` per [`dispatcher-cutover-decom-slot-daemon-claim-loop-2026-05-11`](http://10.77.77.2:3001/agile/story/dispatcher-cutover-decom-slot-daemon-claim-loop-2026-05-11).

## Status

T1 (this repo) shipped. T2-T5 in flight under [`dispatcher-build-chosen-pattern-zdev-2026-05`](http://10.77.77.2:3001/agile/story/dispatcher-build-chosen-pattern-zdev-2026-05).
