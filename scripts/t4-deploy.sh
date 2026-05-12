#!/bin/bash
# Run INSIDE zdev-trigger LXC. Idempotent.
set -euo pipefail

KISS_DIR=/opt/kiss-dispatcher
REPO_URL=https://github.com/web122077-git/kiss-dispatcher.git
ENV_DIR=/etc/kiss-dispatcher
ETC_SYSTEMD=/etc/systemd/system

ROLES=(cpm pm tl be fe do qa doc closer)

OLLAMA_URL_DEFAULT=http://10.50.50.11:11434
CTX_API_DEFAULT=http://10.77.77.2:3001
PG_URL_DEFAULT=postgresql://postgres:kiss-spike-pw@10.98.98.34:5434/dispatcher
HOMELAB_ENV_DEFAULT=zdev

echo "== 1. Clone or pull repo =="
if [ ! -d "$KISS_DIR" ]; then
  git clone "$REPO_URL" "$KISS_DIR"
else
  cd "$KISS_DIR" && git pull --ff-only
fi

echo "== 2. npm install =="
cd "$KISS_DIR" && npm install --omit=dev --silent

echo "== 3. Env dir + per-role envs =="
mkdir -p "$ENV_DIR"
chmod 0750 "$ENV_DIR"

# Per-persona model+NUM_PREDICT (from persona-config v7 + T2h)
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

for role in "${ROLES[@]}"; do
  envfile="$ENV_DIR/$role.env"
  cat > "$envfile" <<EOF
ROLE_HINT=$role
WORKER_ID=zdev-trigger-$role
WORKER_ASSIGNEE_ID=zdev-$role
HOMELAB_ENV=$HOMELAB_ENV_DEFAULT
MODEL=${MODEL[$role]}
NUM_PREDICT=${NUMP[$role]}
OLLAMA_URL=$OLLAMA_URL_DEFAULT
CTX_API=$CTX_API_DEFAULT
PG_URL=$PG_URL_DEFAULT
POLL_INTERVAL_MS=2000
PM_PUSHBACK_CAP=3
QA_REVISE_CAP=3
NODE_ENV=production
EOF
  chmod 0640 "$envfile"
done

# T4 (openclaw-spike-zdev-2026-05): DO worker gets openclaw-mcp tools.
# Only DO advertises openclaw_chat_async / openclaw_task_status / openclaw_task_cancel.
# Other roles' envs are unchanged so their allow-lists exclude these tools.
OPENCLAW_MCP_URL_DEFAULT=${OPENCLAW_MCP_URL_DEFAULT:-http://10.98.98.33:3000}
OPENCLAW_MCP_TOKEN_DEFAULT=${OPENCLAW_MCP_TOKEN_DEFAULT:-}
do_env="$ENV_DIR/do.env"
grep -v -E '^OPENCLAW_MCP_(URL|TOKEN|CLIENT_ID|CLIENT_SECRET)=' "$do_env" > "$do_env.new" || true
echo "OPENCLAW_MCP_URL=$OPENCLAW_MCP_URL_DEFAULT" >> "$do_env.new"
echo "OPENCLAW_MCP_TOKEN=$OPENCLAW_MCP_TOKEN_DEFAULT" >> "$do_env.new"
echo "OPENCLAW_MCP_CLIENT_ID=${OPENCLAW_MCP_CLIENT_ID:-openclaw}" >> "$do_env.new"
echo "OPENCLAW_MCP_CLIENT_SECRET=${OPENCLAW_MCP_CLIENT_SECRET:-}" >> "$do_env.new"
mv "$do_env.new" "$do_env"
chmod 0640 "$do_env"
echo "  DO env injected with OPENCLAW_MCP_URL=$OPENCLAW_MCP_URL_DEFAULT"

echo "== 4. Systemd template =="
cat > "$ETC_SYSTEMD/kiss-dispatcher@.service" <<'EOF'
[Unit]
Description=kiss-dispatcher worker — role %i
After=network-online.target
Wants=network-online.target

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

# Light hardening — workers shouldn't need much
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log /tmp
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "== 5. Reload systemd + enable + start =="
systemctl daemon-reload

for role in "${ROLES[@]}"; do
  systemctl enable "kiss-dispatcher@$role.service" 2>&1 | grep -v "Created symlink" || true
  systemctl restart "kiss-dispatcher@$role.service"
done

echo "== 6. Status snapshot =="
sleep 3
for role in "${ROLES[@]}"; do
  state=$(systemctl is-active "kiss-dispatcher@$role.service" 2>&1)
  printf "  kiss-dispatcher@%-7s %s\n" "$role" "$state"
done

echo "== 7. Last log lines per role =="
for role in "${ROLES[@]}"; do
  echo "---- $role ----"
  journalctl --no-pager -n 5 -u "kiss-dispatcher@$role.service" 2>&1 | tail -5
done

echo "T4 deploy complete."
