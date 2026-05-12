#!/bin/bash
# kiss-dispatcher prod canary rollback — Run ON 10310Aton as root.
# Stops the canary cleanly. Legacy agile-dispatcher remains untouched.
set -euo pipefail

ROLE="${ROLE:-doc}"
echo "== 1. Stop kiss-dispatcher@$ROLE =="
systemctl stop "kiss-dispatcher@$ROLE.service" || true
systemctl disable "kiss-dispatcher@$ROLE.service" || true

echo "== 2. Free any stuck doing-state Tasks held by this worker =="
WORKER="kiss-prod-$ROLE-aton"
TOKEN=$(cat /home/w38122077/.context-api-token 2>/dev/null || true)
# This query intentionally only RELEASES stuck Tasks — it never decides outcome.
curl -s -G "http://10.77.77.2:3001/agile/task?status=doing&assignee=$WORKER" | \
  python3 -c "
import sys,json
d=json.load(sys.stdin)
items=d.get('items',d) if isinstance(d,dict) else d
for t in items:
    print(t.get('id','?'))" | while read tid; do
  if [ -n "$tid" ]; then
    echo "  releasing $tid"
    curl -s -X PATCH "http://10.77.77.2:3001/agile/task/$tid" \
      -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
      --data-binary '{"status":"todo"}' > /dev/null || true
  fi
done

echo "== 3. (Optional) stop kiss-dispatcher-pg container =="
echo "Run manually if you want to wipe state: docker stop kiss-dispatcher-pg"
echo "  data persists at /opt/kiss-dispatcher-pg/data"
echo
echo "prod-canary-uninstall.sh complete."
