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
USER_ID="${USER_ID:-smoke-llm-user}"

if [[ "${FEATURE_LLM:-false}" != "true" ]]; then
  echo "FEATURE_LLM must be true for this smoke test" >&2
  exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

scope_json=$(curl -sS -X POST "$API_BASE_URL/scopes" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke LLM"}')

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

curl -sS -X POST "$API_BASE_URL/memory/events" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\",\"type\":\"stream\",\"content\":\"Shipped initial API endpoints\"}" >/dev/null

curl -sS -X POST "$API_BASE_URL/memory/events" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\",\"type\":\"stream\",\"content\":\"Investigated Redis queue performance\"}" >/dev/null

echo "Inserted events"

job_json=$(curl -sS -X POST "$API_BASE_URL/memory/digest" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\"}")

echo "Digest enqueue response:"
echo "$job_json"

echo "Waiting for digest to be created..."

for i in {1..20}; do
  digests=$(curl -sS "$API_BASE_URL/memory/digests?scopeId=$scope_id&limit=1" -H "x-user-id: $USER_ID")
  digests_b64=$(printf "%s" "$digests" | base64)
  count=$(python3 - <<'PY' "$digests_b64"
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
    echo "Digest created."
    break
  fi
  sleep 3
  if [[ "$i" -eq 20 ]]; then
    echo "Digest not found after waiting." >&2
    echo "Last digests response:"
    echo "$digests"
    exit 1
  fi
done

answer_json=$(curl -sS -X POST "$API_BASE_URL/memory/answer" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\",\"question\":\"What changed recently?\"}")

echo "Answer response:"
echo "$answer_json"

echo "Smoke test complete (LLM enabled)."
