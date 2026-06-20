# P2a — Seed Persona Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject the scope's seed persona (warm-companion `defaultPersonaPrompt`) into the runtime-turn system prompt so chat replies have a personality — fixing that the persona is currently dead config never reaching any model prompt.

**Architecture:** A pure composer `buildRuntimeSystemPrompt(persona, base)` in `@statecore/core` prepends the persona to the base runtime system prompt (persona = voice, base = authoritative operational/grounding rules, kept last). The controller resolves the persona from the scope's domain config (`getDomainConfig(template).defaultPersonaPrompt`) and passes it into `createRuntimeSession`. Runtime path only; `/memory/answer` untouched.

**Tech Stack:** TypeScript, NestJS (apps/api), Vitest, pnpm.

## Global Constraints

- **Runtime path ONLY.** Do NOT touch the `/memory/answer` path (`memory.controller.ts:846 answerSystemPrompt`) or `assistant-runtime.ts` answer logic.
- **Persona = existing domain-config seed**, not user-configurable (§8.1). Source: `getDomainConfig(scope.template).defaultPersonaPrompt`. personal/health have one; **project has none → null → base unchanged**.
- **Persona FIRST, base AFTER** in the composed prompt — base operational/grounding rules must remain the authoritative (last) instructions.
- Do NOT modify `relationship-context.ts`.
- No new persona text — reuse what's in the domain configs.
- Node toolchain: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`. Tests: `pnpm --filter @statecore/core test -- <pat>` / `pnpm --filter @statecore/api test -- <pat>`. Full build: `pnpm build` (tsc, must exit 0).
- This is P2a only — NO 養成/style-learning, NO "我注意到…" confirmation, NO user-visible persona (all P2b).

---

## Task 1: `buildRuntimeSystemPrompt` pure composer (core)

**Files:**
- Create: `packages/core/src/runtime-system-prompt.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/src/runtime-system-prompt.test.ts`

**Interfaces:**
- Produces: `buildRuntimeSystemPrompt(persona: string | null | undefined, base: string): string` — persona prepended (`${persona.trim()}\n\n${base}`) when non-empty after trim; otherwise `base` verbatim.

- [ ] **Step 1: Write the failing test** — create `packages/core/src/runtime-system-prompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt";

const BASE = "You are the synchronous Fast Layer assistant.\nKeep replies concise.";

describe("buildRuntimeSystemPrompt", () => {
  it("prepends persona before base when persona is present", () => {
    const persona = "You are a warm, attentive personal AI companion.";
    const out = buildRuntimeSystemPrompt(persona, BASE);
    expect(out).toBe(`${persona}\n\n${BASE}`);
    expect(out.startsWith(persona)).toBe(true);      // persona first (voice)
    expect(out.endsWith(BASE)).toBe(true);            // base last (authoritative)
  });

  it("trims surrounding whitespace on persona", () => {
    const out = buildRuntimeSystemPrompt("  hello persona  ", BASE);
    expect(out).toBe(`hello persona\n\n${BASE}`);
  });

  it("returns base verbatim when persona is null", () => {
    expect(buildRuntimeSystemPrompt(null, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is undefined", () => {
    expect(buildRuntimeSystemPrompt(undefined, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is empty or whitespace-only", () => {
    expect(buildRuntimeSystemPrompt("", BASE)).toBe(BASE);
    expect(buildRuntimeSystemPrompt("   ", BASE)).toBe(BASE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test -- runtime-system-prompt`
Expected: FAIL — module `./runtime-system-prompt` not found.

- [ ] **Step 3: Implement** — create `packages/core/src/runtime-system-prompt.ts`:

```typescript
/**
 * Compose the runtime-turn system prompt: seed persona (voice) first, then the
 * base operational/grounding instructions, which stay last so they remain the
 * authoritative directives. When no persona is configured (e.g. project
 * template), the base prompt is returned unchanged.
 */
export function buildRuntimeSystemPrompt(persona: string | null | undefined, base: string): string {
  const trimmed = persona?.trim();
  if (!trimmed) return base;
  return `${trimmed}\n\n${base}`;
}
```

- [ ] **Step 4: Export from core** — in `packages/core/src/index.ts`, add near the other re-exports (e.g. after the `getDomainConfig` export at line ~661):

```typescript
export { buildRuntimeSystemPrompt } from "./runtime-system-prompt";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @statecore/core test -- runtime-system-prompt`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime-system-prompt.ts packages/core/src/runtime-system-prompt.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): add buildRuntimeSystemPrompt persona composer

Pure function prepending a seed persona (voice) to the base runtime system
prompt; base operational/grounding rules stay last (authoritative). Returns
base unchanged when no persona is configured. P2a foundation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire persona into the runtime turn (controller)

**Files:**
- Modify: `apps/api/src/memory.controller.ts` (import; `createRuntimeSession` ~297-340; its caller ~414-415)
- Test: `apps/api/src/persona-resolution.test.ts` (new — tests the persona-from-template mapping)

**Interfaces:**
- Consumes: `buildRuntimeSystemPrompt` (Task 1), `getDomainConfig` (already exported from `@statecore/core`), `runtimeSystemPrompt` (already imported from `@statecore/prompts`).
- Produces: runtime-turn system prompt = persona + base for personal/health scopes; base only for project.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/persona-resolution.test.ts`. This pins the persona-resolution rule the controller relies on (personal/health → persona present; project → none), using the real domain configs:

```typescript
import { describe, expect, it } from "vitest";
import { getDomainConfig, buildRuntimeSystemPrompt } from "@statecore/core";

const BASE = "BASE RUNTIME INSTRUCTIONS";

function resolvePersona(template: string | null | undefined): string | null {
  return getDomainConfig(template).defaultPersonaPrompt ?? null;
}

describe("runtime persona resolution", () => {
  it("personal template yields a non-empty persona", () => {
    const persona = resolvePersona("personal");
    expect(persona && persona.length > 0).toBe(true);
    const sys = buildRuntimeSystemPrompt(persona, BASE);
    expect(sys).not.toBe(BASE);          // persona was injected
    expect(sys.endsWith(BASE)).toBe(true);
  });

  it("project template yields no persona → base unchanged", () => {
    const persona = resolvePersona("project");
    expect(persona).toBeNull();
    expect(buildRuntimeSystemPrompt(persona, BASE)).toBe(BASE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @statecore/api test -- persona-resolution`
Expected: FAIL — `buildRuntimeSystemPrompt` not yet exported from `@statecore/core` build, OR (if Task 1 done) the test passes for resolution but the controller isn't wired yet. (If both imports resolve and tests pass at this step because Task 1 shipped the export, that is acceptable — this test documents the mapping; proceed to wire the controller in Step 3.)

- [ ] **Step 3: Implement the controller wiring** — `apps/api/src/memory.controller.ts`:

**a) Ensure imports.** Confirm the top-of-file import from `@statecore/core` includes `getDomainConfig` and `buildRuntimeSystemPrompt`; add whichever is missing to the existing `from "@statecore/core"` import block (the one ending at line ~42):

```typescript
// add these names to the existing `import { ... } from "@statecore/core";`
getDomainConfig,
buildRuntimeSystemPrompt,
```

**b) Add a `personaPrompt` parameter to `createRuntimeSession`** (signature at ~297-305). Add a final optional param and use it for the system prompt. Change the `prompts.system` line (currently `system: runtimeSystemPrompt,` at ~337):

Signature — add after `policyOverrides?: {...}`:
```typescript
    policyOverrides?: {
      recallLimit?: number;
      promoteLongFormToDocumented?: boolean;
      digestOnCandidate?: boolean;
    },
    personaPrompt?: string | null
  ) {
```
Prompts block:
```typescript
      prompts: {
        system: buildRuntimeSystemPrompt(personaPrompt ?? null, runtimeSystemPrompt),
        user: runtimeUserPrompt
      },
```

**c) Resolve persona at the caller** (~line 414-415, where `const session = this.createRuntimeSession(userId, input.scopeId, policyProfile, input.policyOverrides);`). Replace that line with a scope lookup + persona resolution + pass-through:

```typescript
    const scope = await this.domain.projectService.getScope(userId, input.scopeId);
    const personaPrompt = getDomainConfig(scope?.template).defaultPersonaPrompt ?? null;
    const session = this.createRuntimeSession(
      userId,
      input.scopeId,
      policyProfile,
      input.policyOverrides,
      personaPrompt
    );
```
(If the enclosing method's user-id variable is named differently than `userId`, use the actual name in scope at that line — confirm by reading ~400-415. `getScope(userId, scopeId)` is the same signature used at controller lines 493/528/541.)

- [ ] **Step 4: Run tests + build**

Run:
```bash
pnpm --filter @statecore/api test -- persona-resolution
pnpm build
```
Expected: persona-resolution tests PASS; `pnpm build` exits 0 (all packages tsc-clean). If `getScope` returns a type without `template`, confirm `ProjectScope.template` exists (schema.prisma:56 `template String @default("project")`) and the service returns it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/memory.controller.ts apps/api/src/persona-resolution.test.ts
git commit -m "$(cat <<'EOF'
feat(api): inject seed persona into runtime turn system prompt

Runtime-turn handler now resolves the scope's domain-config persona
(getDomainConfig(template).defaultPersonaPrompt) and composes it into the
system prompt via buildRuntimeSystemPrompt. personal/health get the warm
persona; project gets none (base unchanged). /memory/answer untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Benchmark runtimeGrounding non-regression

**Files:** none modified — verification only.

**Interfaces:** Consumes the wired runtime path (Tasks 1-2).

- [ ] **Step 1: Rebuild the stack with the persona wiring**

```bash
docker compose -f docker-compose.local.yml up -d --build api worker
# wait for health
curl -s localhost:3002/health | grep -o '"status":"ok"'
```
Expected: `"status":"ok"`.

- [ ] **Step 2: Run the benchmark (English fixture)**

The benchmark's `loadEnvFile` overrides CLI env, so temporarily point `.env` at the running API, then restore:
```bash
sed -i.bak 's#^API_BASE_URL=http://localhost:3000#API_BASE_URL=http://127.0.0.1:3002#; s#^BENCH_USER_ID=benchmark-user#BENCH_USER_ID=local-dev-user#' .env
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
BENCH_FIXTURE=benchmark-fixtures/basic.json BENCH_SEED=42 node scripts/benchmark/run-benchmark.mjs
mv .env.bak .env
```

- [ ] **Step 3: Confirm non-regression**

Read the latest `benchmark-results/*.json`. Expected vs the pre-P2a baseline (digest consistency 1.0, retention 1.0, overall ~94):
- `reliabilityBreakdown.runtimeGrounding` must NOT drop materially (baseline ~14.6-15).
- digest consistency / retention unchanged (1.0) — runtime persona doesn't touch the digest path.
- If runtimeGrounding regresses, the persona is overriding grounding rules → revisit ordering (reinforce grounding authority in the composer or persona wording). Do NOT proceed to merge if runtimeGrounding regressed.

(Note: the benchmark's runtime scope uses the default template; if its scope is created as `project`, persona won't apply and the run mainly confirms no-harm. The personal-persona behavior is covered by Task 2's unit test + manual spot-check.)

- [ ] **Step 4: No commit** (verification only). Record the runtimeGrounding before/after in the controller's progress notes.

---

## Self-Review

**Spec coverage:**
- §3 runtime-only injection → Task 2 (controller, runtime path only; answer untouched per Global Constraints). ✓
- §4.1 pure composer → Task 1. ✓
- §4.2 persona from getDomainConfig, project→null → Task 2 Step 1 test + Step 3c. ✓
- §4.4 persona-first/base-last ordering → Task 1 impl + test (startsWith/endsWith). ✓
- §5 tests (pure fn, persona mapping, non-regression) → Tasks 1, 2, 3. ✓
- §6 acceptance (answer unchanged, relationship-context untouched) → Global Constraints + scope of edits. ✓

**Placeholder scan:** none — all code shown. ✓

**Type consistency:** `buildRuntimeSystemPrompt(persona: string|null|undefined, base: string): string` consistent across Task 1 def, Task 1 export, Task 2 usage. `getDomainConfig(template).defaultPersonaPrompt ?? null` consistent. ✓
