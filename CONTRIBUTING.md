# Contributing

Thanks for helping improve StateCore.

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
3. Start local infra (Postgres with pgvector + Redis):
   ```bash
   docker compose -f docker-compose.local.yml up -d
   ```
4. Generate Prisma client and migrate:
   ```bash
   pnpm db:generate
   pnpm db:migrate
   ```

The API integration tests need a separate, migrated test database; see
`apps/api/src/test/README.md` for the one-time provisioning.

## Common Commands

- `pnpm dev:api`
- `pnpm dev:worker`
- `pnpm --filter @statecore/core test`
- `pnpm --filter @statecore/api test`
- `pnpm lint` — `tsc --noEmit` across apps and packages
- `pnpm format:check`
- `pnpm build`

## Pull Request Rules

- Keep changes focused and small.
- Add or update tests when behavior changes.
- Update docs for new env vars, endpoints, or workflows.
- Use conventional commits when possible (`feat:`, `fix:`, `docs:`, `chore:`).

## Commit And Release Notes

- Releases run on [Changesets](https://github.com/changesets/changesets). For a
  notable change run `pnpm changeset` and commit the generated file; the release
  writes the per-package `CHANGELOG.md` files from it. **Do not hand-edit those.**
  The root `CHANGELOG.md` is the product-level view and is written at release time.
- If your change touches the `/v1` surface, read the compatibility rules in
  `docs/api.md` first. The contract is additive-only: new endpoints and new
  *optional* fields are fine, and removals, renames, retypes or newly-required
  fields are not. A handler served at `/v1` must be registered in
  `PublicV1Contracts`, and a test fails if it is not.
- If your change affects users, include migration notes in the PR description.

## Reporting Security Issues

Please do not open public issues for vulnerabilities. Follow `SECURITY.md`.
