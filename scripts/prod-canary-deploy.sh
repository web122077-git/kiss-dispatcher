#!/bin/bash
# kiss-dispatcher prod canary deploy — Run ON 10310Aton as root (or via sudo).
# Idempotent. Deploys ONE kiss-dispatcher@<ROLE> systemd unit on Aton.
#
# Story:dispatcher-canary-prod-aton-2026-05
# Decision:decision-dispatcher-coexistence-with-agile-dispatcher-2026-05-11
set -euo pipefail

KISS_DIR=/opt/kiss-dispatcher
SMB_SRC=/10310L/repos/kiss-dispatcher
ENV_DIR=/etc/kiss-dispatcher
ETC_SYSTEMD=/etc/systemd/system

ROLE="${ROLE:-doc}"   # canary role — doc is lowest blast radius (no test-runner)
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5435}"
PG_DB="${PG_DB:-dispatcher}"
PG_USER="${PG_USER:-kissadmin}"
# PG_PASSWORD must be provided by caller (env or sourced from a sealed file)
: "${PG_PASSWORD:?PG_PASSWORD env required}"

CTX_API="${CTX_API:-http://10.77.77.2:3001}"
OLLAMA_URL="${OLLAMA_URL:-http://10.50.50.11:11434}"
PERSONAS_PATH="${PERSONAS_PATH:-/10310L/repos/persona-config/personas.v7.json}"

# Per-persona defaults from t4-deploy.sh
declare -A MODEL=(
  [cpm]=gemma4:latest    [closer]=gemma4:latest
  [pm]=qwen2.5-coder:14b [tl]=qwen2.5-coder:14b [be]=qwen2.5-coder:14b
  [fe]=qwen2.5-coder:14b [do]=qwen2.5-coder:14b [qa]=qwen2.5-coder:14b
  [doc]=qwen2.5-coder:14b
)
declare -A NUMP=(
  [cpm]=400 [pm]=600 [tl]=800 [be]=4000 [fe]=4000 [do]=3000
  [qa]=600  [doc]=2000 [closer]=800
)

echo "== 1. Refresh /opt/kiss-dispatcher from SMB working copy =="
if [ ! -d "$KISS_DIR/.git" ]; then
  git clone "$SMB_SRC" "$KISS_DIR"
else
  (cd "$KISS_DIR" && git fetch --quiet && git reset --hard origin/main)
fi
(cd "$KISS_DIR" && npm install --omit=dev --silent)

echo "== 2. Provision dispatcher_runs schema =="
# Cold-boot guard until kiss-dispatcher-bug-auto-create-dispatcher-runs-schema-2026-05-11 lands
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
  -c "CREATE TABLE IF NOT EXISTS dispatcher_runs (task_id text PRIMARY KEY, role_hint text, worker_id text, status text NOT NULL, result text, test_output jsonb, claimed_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, redispatch_count int NOT NULL DEFAULT 0);" >/dev/null 2>&1 || true

echo "== 3. /etc/kiss-dispatcher/$ROLE.env =="
mkdir -p "$ENV_DIR"
chmod 0750 "$ENV_DIR"
cat > "$ENV_DIR/$ROLE.env" <<EOF
ROLE_HINT=$ROLE
WORKER_ID=kiss-prod-$ROLE-aton
WORKER_ASSIGNEE_ID=prod-$ROLE
HOMELAB_ENV=prod
MODEL=${MODEL[$ROLE]}
NUM_PREDICT=${NUMP[$ROLE]}
OLLAMA_URL=$OLLAMA_URL
CTX_API=$CTX_API
PG_URL=postgresql://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$PG_DB
PERSONAS_PATH=$PERSONAS_PATH
POLL_INTERVAL_MS=2000
PM_PUSHBACK_CAP=3
QA_REVISE_CAP=3
NODE_ENV=production
EOF
chmod 0640 "$ENV_DIR/$ROLE.env"

echo "== 4. systemd template =="
cat > "$ETC_SYSTEMD/kiss-dispatcher@.service" <<'UNIT'
[Unit]
Description=kiss-dispatcher worker — role %i (prod canary)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/kiss-dispatcher
EnvironmentFile=/etc/kiss-dispatcher/%i.env
ExecStart=/usr/bin/node /opt/kiss-dispatcher/src/index.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kiss-dispatcher-%i

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log /tmp
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "== 5. Enable + start =="
systemctl daemon-reload
systemctl enable "kiss-dispatcher@$ROLE.service" 2>&1 | grep -v Created || true
systemctl restart "kiss-dispatcher@$ROLE.service"

echo "== 6. Status =="
sleep 3
systemctl is-active "kiss-dispatcher@$ROLE.service"
journalctl --no-pager -n 5 -u "kiss-dispatcher@$ROLE.service" | tail -5
echo "prod-canary-deploy.sh complete for role=$ROLE."
