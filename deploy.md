# Deploy

StateCore's production stack is a minimal core runtime — no bundled web frontend or reverse proxy:

| Service | Role |
|---------|------|
| `postgres` | Primary database (pgvector/pg16) |
| `redis` | Job queue / pub-sub |
| `migrate` | One-shot Prisma migration runner |
| `api` | NestJS HTTP API (auth via `x-user-id` header) |
| `worker` | Background digest / working-memory workers |

The API listens on `PORT` (default `3000` in the Compose file). If you want public HTTPS exposure, put **your own** reverse proxy (nginx, Traefik, etc.) in front of the `api` container — StateCore no longer ships one.

> **Hosted / managed option:** The statecore-cloud gateway handles public ingress for the managed offering and is maintained outside this repository.

## 1. Prepare the server

Install:

- Docker Engine
- Docker Compose plugin

Clone the repo onto the VPS and enter the project directory.

## 2. Create production env

Copy the template and fill in your values:

```bash
cp .env.production.example .env.production
```

Set at minimum:

- `POSTGRES_PASSWORD`
- `DATABASE_URL` — must use the internal Compose hostname:
  `postgresql://statecore:<password>@postgres:5432/statecore`
- `FEATURE_LLM=true`
- `MODEL_API_KEY` (or the model-specific key variants)

Rate limiting is handled by the upstream gateway/reverse proxy, not the API process.

Recommended model defaults:

- `MODEL_RUNTIME_NAME=gpt-5-nano`
- `MODEL_RUNTIME_REASONING_EFFORT=low`
- `MODEL_RUNTIME_MAX_OUTPUT_TOKENS=400`
- `MODEL_STRUCTURED_OUTPUT_NAME=gpt-5-nano`
- `MODEL_STRUCTURED_OUTPUT_REASONING_EFFORT=low`
- `MODEL_STRUCTURED_OUTPUT_MAX_OUTPUT_TOKENS=600`

Important:

- `REDIS_URL` should stay `redis://redis:6379`

## 3. Build images

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
```

## 4. Start stateful services

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres redis
```

## 5. Run Prisma migrations

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
```

## 6. Start the app stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d api worker
```

## 7. Verify

Check containers:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

Check the API health (the API requires a user identity header):

```bash
curl -H 'x-user-id: deploy-check' http://localhost:3000/health
```

Run the smoke suite against the local stack:

```bash
BASE_URL=http://localhost:3000 pnpm smoke:deploy
```

If you have a reverse proxy in front, substitute your public URL:

```bash
BASE_URL=https://your-domain.example pnpm smoke:deploy
```

That smoke verifies:

- the API is reachable
- a scope can be created
- a natural-language runtime turn succeeds
- Working Memory captures a goal
- Stable State commits a goal
- layer alignment and freshness converge cleanly

## 8. Updates

Pull new code, then:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d api worker
```

## Notes

- `worker` must stay running. This project is not API-only.
- **Multi-instance:** Run multiple API/worker replicas only in full mode (Redis-backed BullMQ). `STATECORE_MODE=lite` uses an in-process queue and is single-instance / development only.
- For public HTTPS, place your own reverse proxy (nginx, Traefik, etc.) in front of the `api` port.
