#!/bin/bash
# Run INSIDE zdev-trigger. Pull latest kiss-dispatcher + persona-config, update envs, restart.
set -euo pipefail

KISS_DIR=/opt/kiss-dispatcher
PERSONA_DIR=/opt/persona-config
ENV_DIR=/etc/kiss-dispatcher
ROLES=(cpm pm tl be fe do qa doc closer)
PAT_FILE=/root/.github-pat

echo "== 1. Clone persona-config =="
if [ ! -d "$PERSONA_DIR" ]; then
  if [ -f "$PAT_FILE" ]; then
    PAT=$(cat "$PAT_FILE")
    git clone "https://web122077-git:${PAT}@github.com/web122077-git/persona-config.git" "$PERSONA_DIR"
  else
    git clone https://github.com/web122077-git/persona-config.git "$PERSONA_DIR" || {
      echo "persona-config clone failed — likely needs PAT. Provide at $PAT_FILE."
      exit 1
    }
  fi
else
  cd "$PERSONA_DIR" && git pull --ff-only
fi
test -f "$PERSONA_DIR/personas.v7.json" || { echo "personas.v7.json missing"; exit 1; }

echo "== 2. Pull kiss-dispatcher =="
cd "$KISS_DIR" && git pull --ff-only
cd "$KISS_DIR" && npm install --omit=dev --silent

echo "== 3. Append PERSONAS_PATH to each role env =="
for role in "${ROLES[@]}"; do
  envfile="$ENV_DIR/$role.env"
  # remove any existing PERSONAS_PATH line then append
  grep -v '^PERSONAS_PATH=' "$envfile" > "$envfile.new" || true
  echo "PERSONAS_PATH=$PERSONA_DIR/personas.v7.json" >> "$envfile.new"
  mv "$envfile.new" "$envfile"
  chmod 0640 "$envfile"
done

echo "== 4. Restart workers =="
systemctl daemon-reload
for role in "${ROLES[@]}"; do
  systemctl restart "kiss-dispatcher@$role.service"
done

echo "== 5. Status =="
sleep 6
for role in "${ROLES[@]}"; do
  state=$(systemctl is-active "kiss-dispatcher@$role.service" 2>&1)
  printf "  kiss-dispatcher@%-7s %s\n" "$role" "$state"
done
echo "T4 redeploy complete."
