# API Primitives

All endpoints require an identity header:
- `x-user-id` for developer/self-host
- `x-telegram-user-id` for adapter usage

Server stores a normalized `identity` per user (e.g. `user:...`, `local:...`, `telegram:...`), while `telegramUserId` is reserved for raw Telegram IDs used by reminder delivery.

## Ingest
- **POST /memory/events**
  - body: `{ scopeId, type: 'stream'|'document', source?, key?, content }`
  - `document` requires `key` (upsert by key)

## Digest
- **POST /memory/digest**
  - body: `{ scopeId }` (enqueue job)
- requires `FEATURE_LLM=true` and `OPENAI_API_KEY`
- returns actionable error when disabled
- **POST /memory/digest/rebuild**
  - body: `{ scopeId, from?, to?, strategy?: 'full'|'since_last_good' }`
  - enqueues `rebuild_digest_chain`
- **GET /memory/digests?scopeId=&limit=&cursor=**

## Retrieve
- **POST /memory/retrieve**
  - body: `{ scopeId, query, limit? }`
  - returns last digest + recent events (simple baseline, query currently not used for ranking)

## Answer (LLM optional)
- **POST /memory/answer**
  - body: `{ scopeId, question }`
  - requires `FEATURE_LLM=true` (otherwise 400)

## Scopes
- **POST /scopes**
- **GET /scopes**
- **POST /scopes/:id/active**
- **GET /state**

## Reminders
- **POST /reminders**
- **GET /reminders?status=&limit=&cursor=**
- **POST /reminders/:id/cancel**

## Health
- **GET /health**

## Example (curl)
```bash
curl -X POST "$API_BASE_URL/scopes" \
  -H 'x-user-id: dev-user' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo"}'

curl -X POST "$API_BASE_URL/memory/events" \
  -H 'x-user-id: dev-user' \
  -H 'Content-Type: application/json' \
  -d '{"scopeId":"<scopeId>","type":"stream","content":"First note"}'
```
