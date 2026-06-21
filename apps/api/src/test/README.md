# API integration tests — test database setup

`api.integration.test.ts` runs against a **real Postgres test database**, separate
from the dev DB. `vitest.setup.ts` points `DATABASE_URL` at `DATABASE_URL_TEST`
(default `postgresql://postgres:postgres@localhost:5434/statecore_test`) before any
module loads, and `helpers.ts#clearDatabase` truncates tables between tests.

The test DB must **exist and be migrated** before running these tests, otherwise
Prisma fails with `PrismaClientInitializationError` and the 6 integration tests fail.

## One-time provisioning (per environment / CI)

With the local Postgres up (`docker compose -f docker-compose.local.yml up -d postgres`):

```bash
# 1. Create the test database
docker exec statecore-postgres-1 psql -U postgres -c "CREATE DATABASE statecore_test"

# 2. Apply all migrations to it
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/statecore_test" \
  pnpm --filter @statecore/db prisma migrate deploy
```

Then `pnpm --filter @statecore/api test` runs green (integration tests included).

When new migrations are added, re-run step 2 to keep the test DB schema current.

> Pure unit tests (e.g. `packages/core`, `apps/worker` with mocked Prisma) do NOT
> need this — only `apps/api`'s integration tests hit a real DB.
