#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
USER_ID="${USER_ID:-smoke-reminder-user}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

scope_json=$(curl -sS -X POST "$API_BASE_URL/scopes" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Reminders"}')

echo "Create scope response:"
echo "$scope_json"

scope_id=$(python3 - <<PY
import json, sys
try:
    data = json.loads('''$scope_json''')
except Exception as e:
    print(e)
    sys.exit(1)
if 'id' not in data:
    print(data)
    sys.exit(1)
print(data['id'])
PY
) || { echo "Failed to create scope"; exit 1; }

echo "Created scope: $scope_id"

due_at=$(python3 - <<PY
import datetime
print((datetime.datetime.utcnow() + datetime.timedelta(seconds=20)).isoformat() + "Z")
PY
)

reminder_json=$(curl -sS -X POST "$API_BASE_URL/reminders" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\",\"dueAt\":\"$due_at\",\"text\":\"Smoke reminder\"}")

echo "Reminder create response:"
echo "$reminder_json"

echo "Waiting for reminder to be sent..."

for i in {1..24}; do
  reminders=$(curl -sS "$API_BASE_URL/reminders?status=sent&limit=5" -H "x-user-id: $USER_ID")
  reminders_b64=$(printf "%s" "$reminders" | base64)
  count=$(python3 - <<'PY' "$reminders_b64"
import base64, json, sys
raw = base64.b64decode(sys.argv[1]).decode("utf-8", "replace")
try:
    data = json.loads(raw)
except Exception:
    print(0)
    sys.exit(0)
print(len(data.get("items", [])))
PY
)
  if [[ "$count" -gt 0 ]]; then
    echo "Reminder sent."
    break
  fi
  sleep 5
  if [[ "$i" -eq 24 ]]; then
    echo "Reminder not sent after waiting." >&2
    echo "Last reminders response:"
    echo "$reminders"
    exit 1
  fi
done

echo "Smoke test complete (reminders)."
