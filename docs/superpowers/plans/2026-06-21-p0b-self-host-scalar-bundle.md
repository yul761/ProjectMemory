# P0b — Self-host the Scalar `/docs` bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Scalar API-reference UI bundle from our own origin instead of a third-party CDN, so `/docs` works offline and the unauthenticated, credential-handling page does not execute unpinned third-party JavaScript.

**Architecture:** Add `@scalar/api-reference` (the standalone browser bundle), serve its file at same-origin `GET /docs/scalar.js` (path resolved exactly as jsdelivr resolves a path-less package URL — the package's `jsdelivr`/`unpkg`/`browser`/`main` field), and pass Scalar's `cdn: "/docs/scalar.js"` so the generated `/docs` HTML loads the bundle from us.

**Tech Stack:** NestJS/Express, `@scalar/express-api-reference@0.10.4`, `@scalar/api-reference`, Node ESM (`createRequire`).

## Background

P0's final review flagged: `/docs` (Scalar) loads its UI from `https://cdn.jsdelivr.net/npm/@scalar/api-reference` — unpinned, no SRI — on an unauthenticated page whose "try it" console collects the `x-user-id` credential. Mechanism confirmed: `apiReference({ cdn })` → `renderApiReference` →
`<script src="${cdn ?? DEFAULT_CDN}">` where `DEFAULT_CDN = https://cdn.jsdelivr.net/npm/@scalar/api-reference` (`@scalar/client-side-rendering/dist/html-rendering.js:2,138`). Passing `cdn` overrides it.

## Global Constraints

- Modify only `apps/api/src/main.ts` and `apps/api/package.json` (+ lockfile). No other files.
- No `any`.
- The `/docs/scalar.js` route must be registered BEFORE `app.use("/docs", apiReference(...))` so the specific asset path matches first.
- `/docs` and `/docs/` are already auth- and rate-limit-exempt (P0 Task 2) — `/docs/scalar.js` is covered by the `/docs/` prefix; do not change the middleware.
- Conventional-commit message ending with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Test-harness note

`createTestApp` does not run `main.ts`, so neither `/docs` nor `/docs/scalar.js` is exercised by the vitest harness. Verification of those is by smoke against a running server. The existing `/openapi.json` integration test must keep passing.

---

### Task 1: Serve the Scalar bundle locally and point `/docs` at it

**Files:**
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json` (add `@scalar/api-reference`) + `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `apiReference` from `@scalar/express-api-reference` (already imported in `main.ts` from P0).

- [ ] **Step 1: Add the standalone bundle package**

Run: `pnpm --filter @statecore/api add @scalar/api-reference`
Expected: `apps/api/package.json` gains `@scalar/api-reference` under dependencies; lockfile updates.

- [ ] **Step 2: Confirm the package ships a resolvable standalone bundle**

Run:
```bash
node -e "const r=require('module').createRequire(process.cwd()+'/apps/api/');const p=r.resolve('@scalar/api-reference/package.json');const pkg=require(p);console.log('dir:',require('path').dirname(p));console.log('jsdelivr:',pkg.jsdelivr,'| unpkg:',pkg.unpkg,'| browser:',pkg.browser,'| main:',pkg.main)"
```
Expected: prints the package dir and at least one of `jsdelivr`/`unpkg`/`browser`/`main` pointing to a `.js` standalone build. Confirm that file exists (`ls <dir>/<field>`).

**Fallback:** if NONE of those fields resolves to an existing single-file `.js` bundle (i.e. the package only ships an unbundled/ESM entry needing a bundler), STOP and report — do not hand-roll a bundler. The fallback is method A (pin the CDN to an exact version): change the P0 `apiReference({ url })` call to `apiReference({ url: "/openapi.json", cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@<resolved-installed-version>" })` using the installed `@scalar/api-reference` version, and note offline is not solved. Report which path you took.

- [ ] **Step 3: Serve the bundle at `/docs/scalar.js` and point Scalar at it**

In `apps/api/src/main.ts`:

Add imports near the top:
```ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
```

Resolve the standalone bundle path once (module scope, before `bootstrap`):
```ts
const scalarRequire = createRequire(import.meta.url);
const scalarPkgJson = scalarRequire.resolve("@scalar/api-reference/package.json");
const scalarPkg = JSON.parse(readFileSync(scalarPkgJson, "utf8")) as {
  jsdelivr?: string; unpkg?: string; browser?: string; main?: string;
};
const scalarBundleRel = scalarPkg.jsdelivr ?? scalarPkg.unpkg ?? scalarPkg.browser ?? scalarPkg.main;
if (!scalarBundleRel) throw new Error("Could not resolve @scalar/api-reference standalone bundle");
const scalarBundlePath = join(dirname(scalarPkgJson), scalarBundleRel);
```

In `bootstrap()`, replace the existing
`app.use("/docs", apiReference({ url: "/openapi.json" }));`
with the asset route FIRST, then the self-hosted-cdn Scalar mount:
```ts
  app.use("/docs/scalar.js", (_req: Request, res: Response) =>
    res.type("application/javascript").sendFile(scalarBundlePath)
  );
  app.use("/docs", apiReference({ url: "/openapi.json", cdn: "/docs/scalar.js" }));
```
(`Request`/`Response` are already imported from `express` in main.ts.)

- [ ] **Step 4: Typecheck + full api suite (no regression)**

Run: `pnpm --filter @statecore/api exec tsc --noEmit && pnpm --filter @statecore/api test`
Expected: no type errors; full suite green (the `/openapi.json` integration test still passes; nothing else changed).

- [ ] **Step 5: Smoke-verify the self-hosted docs against a running server**

Start the API (deps up + env configured), then:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/docs/scalar.js   # expect 200
curl -s http://localhost:3002/docs/scalar.js | head -c 40                        # expect JS, not HTML
curl -s http://localhost:3002/docs | grep -o '/docs/scalar.js'                   # expect the local path present
curl -s http://localhost:3002/docs | grep -c 'jsdelivr' || true                  # expect 0 (no CDN reference)
```
Expected: `/docs/scalar.js` → 200 JS; the `/docs` HTML references `/docs/scalar.js` and contains no `jsdelivr`. Stop the server afterward.
If the local env cannot start the full server, record that the smoke was not run locally and that the change is verified by inspection (the `cdn` option flows to the `<script src>` per `html-rendering.js:138`); do NOT fake results.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/main.ts apps/api/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
fix(api): self-host the Scalar /docs bundle instead of a third-party CDN

/docs now loads the Scalar UI from same-origin /docs/scalar.js (the
@scalar/api-reference standalone bundle, resolved like jsdelivr resolves a
path-less package URL) via Scalar's cdn option, so the docs render offline and
the unauthenticated, credential-handling page no longer executes unpinned
third-party JavaScript. Closes P0 final-review follow-up #2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:** add `@scalar/api-reference` (Step 1); resolve + serve the standalone bundle at `/docs/scalar.js` (Steps 2-3); point Scalar's `cdn` at it (Step 3); offline/no-jsdelivr verification (Step 5); fallback to pinned-CDN if no clean bundle (Step 2). ✓

**Placeholder scan:** complete code; the only deferred value is the package's actual standalone field, resolved at runtime by reading package.json (not a placeholder — the resolution logic is given). ✓

**Type consistency:** `scalarBundlePath: string` used by `sendFile`; `Request`/`Response` reused from the existing express import. ✓
