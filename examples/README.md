# StateCore quickstart example

`quickstart.sh` walks the core memory loop against the frozen `/v1` API:
create a scope → ingest a document + a stream event → trigger a digest →
retrieve grounded evidence → read the stable state.

## Prerequisites (cold start)

1. Start the stack (Postgres + Redis + API + worker):
   ```bash
   docker compose -f docker-compose.local.yml up -d
   ```
   (or run `pnpm start` per the root README, with your `.env` configured).
2. Apply migrations if not auto-applied (see deploy.md).
3. Confirm health: `curl http://localhost:3002/health` returns ok.
4. Digest/retrieve quality needs LLM features enabled (`FEATURE_LLM=true` + a
   model key in `.env`); without them the digest step is a no-op and retrieve
   falls back to heuristic ranking.

## Run

```bash
STATECORE_URL=http://localhost:3002 STATECORE_USER=local-dev-user \
  bash examples/quickstart.sh
```

Requires `curl` and `jq`. The script exits on the first error (`set -euo pipefail`),
so a clean run end-to-end is itself a functional cold-start check.

For deeper smoke checks see `scripts/smoke-*.sh`.
