# Release Process

Project Memory uses a lightweight Changesets-based flow.

## 1) Add changeset

```bash
pnpm changeset
```

Choose affected packages and bump type.

## 2) Validate before merge

```bash
pnpm --filter @project-memory/core test
pnpm build
```

## 3) Prepare release

```bash
pnpm release:status
```

Then update `CHANGELOG.md` and tag a release in GitHub.

## Notes

- Replace `your-org/project-memory` in `.changeset/config.json` with your real GitHub repo.
- For fully automated publishing, add npm/token workflow later.
