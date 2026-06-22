#!/usr/bin/env bash
# StateCore quickstart: ingest -> digest -> retrieve against the frozen /v1 API.
# Requires: a running StateCore stack (see examples/README.md), curl, jq.
#
#   STATECORE_URL   API base URL   (default http://localhost:3002)
#   STATECORE_USER  x-user-id      (default local-dev-user)
set -euo pipefail

URL="${STATECORE_URL:-http://localhost:3002}"
USER_ID="${STATECORE_USER:-local-dev-user}"
H_AUTH=(-H "x-user-id: ${USER_ID}")
H_JSON=(-H "content-type: application/json")

say() { printf '\n=== %s ===\n' "$1"; }

say "health"
curl -fsS "${URL}/health" | jq .

say "create scope"
SCOPE_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/scopes" \
  -d '{"name":"quickstart-demo","goal":"ship the beta","template":"project"}' | jq -r .id)
echo "scopeId=${SCOPE_ID}"

say "ingest a document"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/events" \
  -d "{\"scopeId\":\"${SCOPE_ID}\",\"type\":\"document\",\"source\":\"api\",\"key\":\"plan\",\"content\":\"goal: ship the beta. decision: use postgres for storage. todo: write integration tests.\"}" | jq .

say "ingest a stream event"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/events" \
  -d "{\"scopeId\":\"${SCOPE_ID}\",\"type\":\"stream\",\"source\":\"api\",\"content\":\"we decided to use redis for the job queue\"}" | jq .

say "trigger a digest (async job)"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/digest" \
  -d "{\"scopeId\":\"${SCOPE_ID}\"}" | jq .
say "wait for the digest worker to build stable state"
# The digest is async (an LLM call — typically ~10-20s). Poll the stable-state
# read model until it populates, or give up after ~30s (if LLM is disabled the
# digest is a no-op and stable state stays empty — that's expected).
for _ in $(seq 1 15); do
  GOAL=$(curl -fsS "${H_AUTH[@]}" "${URL}/memory/stable-state?scopeId=${SCOPE_ID}" | jq -r '.state.stableFacts.goal // empty')
  if [ -n "${GOAL}" ]; then echo "stable state ready (goal: ${GOAL})"; break; fi
  printf '.'; sleep 2
done
echo

say "retrieve grounded evidence"
curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "${URL}/v1/memory/retrieve" \
  -d "{\"scopeId\":\"${SCOPE_ID}\",\"query\":\"what storage did we choose?\",\"limit\":10}" | jq .

say "current stable state (internal read model — not part of the frozen /v1 contract)"
# stable-state is registered only at /memory/stable-state, not under /v1
curl -fsS "${H_AUTH[@]}" "${URL}/memory/stable-state?scopeId=${SCOPE_ID}" | jq .

say "done"
