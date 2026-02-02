#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
USER_ID="${USER_ID:-smoke-user}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

scope_json=$(curl -sS -X POST "$API_BASE_URL/scopes" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke No LLM"}')

echo "Create scope response:"
echo "$scope_json"

scope_id=$(python3 - <<PY
import json, sys
data = json.loads('''$scope_json''')
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
  -d "{\"scopeId\":\"$scope_id\",\"type\":\"stream\",\"content\":\"First event\"}" >/dev/null

curl -sS -X POST "$API_BASE_URL/memory/events" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\",\"type\":\"document\",\"key\":\"note:design\",\"content\":\"Design v1\"}" >/dev/null

echo "Inserted stream + document events"

retrieve_json=$(curl -sS -X POST "$API_BASE_URL/memory/retrieve" \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"scopeId\":\"$scope_id\",\"query\":\"summary\"}")

echo "Retrieve result:"
echo "$retrieve_json"

echo "Smoke test complete (no LLM)."
