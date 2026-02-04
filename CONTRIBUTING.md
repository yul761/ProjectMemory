# Contributing

Thanks for helping improve Project Memory.

## Development Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Copy env files:
   ```bash
   cp .env.example .env
   cp .env packages/db/.env
   ```
3. Start local infra:
   ```bash
   docker-compose up -d
   ```
4. Generate Prisma client and migrate:
   ```bash
   pnpm db:generate
   pnpm db:migrate
   ```

## Common Commands

- `pnpm dev:api`
- `pnpm dev:worker`
- `pnpm dev:telegram`
- `pnpm dev:cli -- scopes`
- `pnpm --filter @project-memory/core test`
- `pnpm -r --filter "./apps/**" --filter "./packages/**" build`

## Pull Request Rules

- Keep changes focused and small.
- Add or update tests when behavior changes.
- Update docs for new env vars, endpoints, or workflows.
- Use conventional commits when possible (`feat:`, `fix:`, `docs:`, `chore:`).

## Commit And Release Notes

- Add a short changelog entry in `CHANGELOG.md` for notable changes.
- If your change affects users, include migration notes in the PR description.

## Reporting Security Issues

Please do not open public issues for vulnerabilities. Follow `SECURITY.md`.
