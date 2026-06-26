# Forget-Prune-Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "forget" truly stick — prune forgotten facts from the carried digest state (profile facets + factRegistry) before the summary is generated, so the assistant stops surfacing them.

**Architecture:** A pure `pruneForgottenFacts(state, keys)` in `@statecore/core` removes any profile-facet value / profile factRegistry entry whose `computeFactKey(factToGroup(facet), content)` is in the scope's forgotten set. `runDigestControlPipeline` gains an optional `forgottenFactKeys` param (default → unchanged behavior) and calls the prune right after `protectedStateMerge`, before `generateDigestStage2`. The worker loads the scope's `ForgottenFact` keys and passes them in.

**Tech Stack:** TypeScript, vitest, Prisma. pnpm workspaces (`@statecore/core`, `@statecore/worker`).

## Global Constraints

- **Backward compatible:** the new `forgottenFactKeys` param on `runDigestControlPipeline` is OPTIONAL; when omitted/empty the pipeline behaves byte-identically to today. Do not change `protectedStateMerge` / `mergeProfileFacets` / `generateDigestStage2` algorithms — only insert one additive prune step.
- **Key computation must match the display/forget path exactly:** a fact's key is `computeFactKey(factToGroup(facet), content)` (the same as `flattenScopeFacts` in `packages/core/src/memory-facts.ts`). Facets with `factToGroup(facet) === null` (e.g. `identity`) are never pruned (never forgettable).
- **Prune covers both** bare profile-facet strings (`state.profile[facet]`) AND profile-type `state.factRegistry` entries (those with a `facet` mapping to a group).
- **Guarantee:** the state RETURNED by `runDigestControlPipeline` (`result.state`, which the worker writes to the snapshot) must never contain a forgotten fact when keys are supplied. The test enforces this on all return paths.
- **No schema change → no migration. No `/v1` contract / OpenAPI change** (purely internal digest behavior).
- `pruneForgottenFacts` is a pure function, mutates `state` in place (returns `void`), matching `mergeProfileFacets`.
- Run core tests for one file: `pnpm --filter @statecore/core test <pattern>`. Build: `pnpm --filter @statecore/core build`, `pnpm --filter @statecore/worker build`.

---

## File Structure

- **Modify** `packages/core/src/memory-facts.ts` — add `pruneForgottenFacts`.
- **Modify** `packages/core/src/memory-facts.test.ts` — unit tests for it.
- **Modify** `packages/core/src/digest-control.ts` — add optional `forgottenFactKeys` to `runDigestControlPipeline`'s input; call `pruneForgottenFacts` after `protectedStateMerge`.
- **Modify** `packages/core/src/digest-control.test.ts` — pipeline test (with/without keys).
- **Modify** `apps/worker/src/main.ts` — load `ForgottenFact` keys for the scope; pass `forgottenFactKeys` into the pipeline call.

---

### Task 1: `pruneForgottenFacts` pure function

**Files:**
- Modify: `packages/core/src/memory-facts.ts`
- Test: `packages/core/src/memory-facts.test.ts`

**Interfaces:**
- Consumes: `computeFactKey`, `factToGroup`, `type DigestState` (already in this file).
- Produces: `pruneForgottenFacts(state: DigestState, forgottenFactKeys: ReadonlySet<string>): void` — removes, in place, any `state.profile[facet]` value and any `state.factRegistry` entry whose `computeFactKey(factToGroup(facet), content)` is in `forgottenFactKeys`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/memory-facts.test.ts`:
```typescript
import { pruneForgottenFacts } from "./memory-facts";

describe("pruneForgottenFacts", () => {
  function baseState(): DigestState {
    return {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        { id: "f1", content: "Launching Remi in July", type: "profile", confidence: 0.85, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev1", evidenceType: "event", facet: "goals" },
        { id: "f2", content: "internal decision", type: "decision", confidence: 0.7, addedAt: "2026-06-20T00:00:00.000Z", evidenceId: "ev2", evidenceType: "event" }
      ],
      profile: {
        identity: ["Name is Yuchen"],
        relationships: ["Call the supplier about Q3"],
        style: ["Prefers meetings after 2pm"]
      }
    };
  }

  it("removes a bare profile-facet value whose key is forgotten", () => {
    const state = baseState();
    const key = computeFactKey("People", "Call the supplier about Q3"); // relationships → People
    pruneForgottenFacts(state, new Set([key]));
    expect(state.profile!.relationships).toEqual([]);
    expect(state.profile!.style).toEqual(["Prefers meetings after 2pm"]); // untouched
  });

  it("removes a profile-type factRegistry entry whose key is forgotten", () => {
    const state = baseState();
    const key = computeFactKey("Projects", "Launching Remi in July"); // goals → Projects
    pruneForgottenFacts(state, new Set([key]));
    expect(state.factRegistry!.find((e) => e.id === "f1")).toBeUndefined();
    expect(state.factRegistry!.find((e) => e.id === "f2")).toBeDefined(); // non-profile decision kept
  });

  it("never prunes identity (factToGroup → null) and is a no-op for an empty set", () => {
    const state = baseState();
    const idKey = computeFactKey("identity", "Name is Yuchen");
    pruneForgottenFacts(state, new Set([idKey])); // identity isn't a display group → no match
    expect(state.profile!.identity).toEqual(["Name is Yuchen"]);
    const before = JSON.stringify(baseState());
    const s2 = baseState();
    pruneForgottenFacts(s2, new Set());
    expect(JSON.stringify(s2)).toEqual(before); // empty set = no change
  });

  it("leaves non-matching content untouched", () => {
    const state = baseState();
    pruneForgottenFacts(state, new Set([computeFactKey("People", "someone else")]));
    expect(state.profile!.relationships).toEqual(["Call the supplier about Q3"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @statecore/core test memory-facts`
Expected: FAIL — `pruneForgottenFacts` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/memory-facts.ts`, add at the end of the file:
```typescript
export function pruneForgottenFacts(state: DigestState, forgottenFactKeys: ReadonlySet<string>): void {
  if (forgottenFactKeys.size === 0) return;

  // Bare profile-facet strings.
  const profile = state.profile;
  if (profile) {
    for (const [facet, values] of Object.entries(profile)) {
      const group = factToGroup(facet);
      if (!group || !Array.isArray(values)) continue;
      (profile as Record<string, string[]>)[facet] = values.filter(
        (v) => !forgottenFactKeys.has(computeFactKey(group, v))
      );
    }
  }

  // Profile-type factRegistry entries (those with a facet mapping to a display group).
  if (Array.isArray(state.factRegistry)) {
    state.factRegistry = state.factRegistry.filter((entry) => {
      const group = entry.facet ? factToGroup(entry.facet) : null;
      if (!group) return true; // not a displayable profile fact → keep
      return !forgottenFactKeys.has(computeFactKey(group, entry.content));
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @statecore/core test memory-facts`
Expected: PASS.

- [ ] **Step 5: Build core**

Run: `pnpm --filter @statecore/core build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/memory-facts.ts packages/core/src/memory-facts.test.ts
git commit -m "feat(core): pruneForgottenFacts — remove forgotten facts from digest state"
```

---

### Task 2: Thread `forgottenFactKeys` into `runDigestControlPipeline` + call the prune

**Files:**
- Modify: `packages/core/src/digest-control.ts` (`runDigestControlPipeline`, signature ~L2107-2127, body ~L2196-2210)
- Test: `packages/core/src/digest-control.test.ts`

**Interfaces:**
- Consumes: `pruneForgottenFacts` from `./memory-facts` (Task 1).
- Produces: `runDigestControlPipeline` accepts an optional `forgottenFactKeys?: ReadonlySet<string>` on its input object; the returned `result.state` never contains a fact whose key is in that set.

- [ ] **Step 1: Write the failing test**

Add to the `describe("runDigestControlPipeline", ...)` block in `packages/core/src/digest-control.test.ts`. Mirror the existing no-change test setup (llm.chat throws if called — proves we don't need generation for this assertion; the merged state is still produced + pruned + returned):
```typescript
it("prunes a forgotten profile fact from the returned state", async () => {
  const prevState = normalizeDigestState({
    stableFacts: { decisions: [] },
    workingNotes: {},
    todos: [],
    profile: { relationships: ["Call the supplier about Q3"], style: ["Prefers meetings after 2pm"] }
  });
  const forgottenKey = computeFactKey("People", "Call the supplier about Q3");
  const result = await runDigestControlPipeline({
    scope: { id: "s", userId: "u", name: "Demo", goal: "g", stage: "build", createdAt: new Date() },
    lastDigest: { id: "d1", scopeId: "s", summary: "x", changes: "", nextSteps: [], createdAt: new Date("2026-03-19T00:00:10Z") },
    prevState,
    recentEvents: [],
    llm: { chat: async () => { throw new Error("llm should not be called"); } },
    prompts: { digestStage2SystemPrompt: "system", digestStage2UserPrompt: "{{scopeName}}" },
    config: { eventBudgetTotal: 10, eventBudgetDocs: 5, eventBudgetStream: 5, noveltyThreshold: 0.5, maxRetries: 1, useLlmClassifier: false, debug: false },
    forgottenFactKeys: new Set([forgottenKey])
  });
  expect(result.state.profile?.relationships ?? []).not.toContain("Call the supplier about Q3");
  expect(result.state.profile?.style ?? []).toContain("Prefers meetings after 2pm"); // unrelated fact kept
});

it("without forgottenFactKeys the state is unchanged (backward compatible)", async () => {
  const prevState = normalizeDigestState({
    stableFacts: { decisions: [] }, workingNotes: {}, todos: [],
    profile: { relationships: ["Call the supplier about Q3"] }
  });
  const result = await runDigestControlPipeline({
    scope: { id: "s", userId: "u", name: "Demo", goal: "g", stage: "build", createdAt: new Date() },
    lastDigest: { id: "d1", scopeId: "s", summary: "x", changes: "", nextSteps: [], createdAt: new Date("2026-03-19T00:00:10Z") },
    prevState, recentEvents: [],
    llm: { chat: async () => { throw new Error("llm should not be called"); } },
    prompts: { digestStage2SystemPrompt: "system", digestStage2UserPrompt: "{{scopeName}}" },
    config: { eventBudgetTotal: 10, eventBudgetDocs: 5, eventBudgetStream: 5, noveltyThreshold: 0.5, maxRetries: 1, useLlmClassifier: false, debug: false }
    // no forgottenFactKeys
  });
  expect(result.state.profile?.relationships ?? []).toContain("Call the supplier about Q3");
});
```
(Ensure `computeFactKey` is imported in this test file — import from `./memory-facts` if not already.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @statecore/core test digest-control`
Expected: FAIL — the first test still contains the forgotten fact (param not wired / prune not called).

- [ ] **Step 3: Implement**

In `packages/core/src/digest-control.ts`:
- Add to the imports (top of file): `import { pruneForgottenFacts } from "./memory-facts";` (if `memory-facts` importing `digest-control` causes a cycle warning, that's fine — they already cross-reference for types; verify the build).
- Add the optional param to the `runDigestControlPipeline` input object type (in the signature ~L2107):
  ```typescript
    config: DigestControlConfig;
    forgottenFactKeys?: ReadonlySet<string>;
  }): Promise<{ ... }>
  ```
- Right AFTER the `protectedStateMerge` call (where `const state = protectedStateMerge({...})` is assigned, ~L2197-2202) and BEFORE `generateDigestStage2` (~L2204), insert:
  ```typescript
  if (input.forgottenFactKeys && input.forgottenFactKeys.size > 0) {
    pruneForgottenFacts(state, input.forgottenFactKeys);
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @statecore/core test digest-control`
Expected: PASS (both new tests + the existing suite stays green).
**Guarantee check:** the "prunes a forgotten profile fact from the returned state" test asserts `result.state` is clean. If it fails because the no-change path returns a state that did NOT go through the `state` variable you pruned, adjust so the returned state is always pruned (e.g. also prune `result.state` immediately before each `return`, or prune `input.prevState` at entry) — `result.state` must never contain a forgotten fact when keys are supplied.

- [ ] **Step 5: Build core**

Run: `pnpm --filter @statecore/core build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "feat(core): prune forgotten facts in runDigestControlPipeline (opt-in param)"
```

---

### Task 3: Worker loads ForgottenFact keys and passes them in

**Files:**
- Modify: `apps/worker/src/main.ts` (`runDigestScopeJob`, ~L218-277)

**Interfaces:**
- Consumes: `runDigestControlPipeline`'s new optional `forgottenFactKeys` param (Task 2); the `ForgottenFact` Prisma model (`prisma.forgottenFact`).
- Produces: the worker supplies the scope's forgotten-fact keys on every digest run.

- [ ] **Step 1: Load the forgotten keys and pass them in**

In `apps/worker/src/main.ts`, inside `runDigestScopeJob`, after `recentEvents` is built and before the `runDigestControlPipeline(...)` call (~L255), add:
```typescript
  const forgottenRows = await prisma.forgottenFact.findMany({
    where: { scopeId: data.scopeId },
    select: { factKey: true }
  });
  const forgottenFactKeys = new Set(forgottenRows.map((f) => f.factKey));
```
Then add `forgottenFactKeys` to the pipeline call's input object (alongside `config: {...}`):
```typescript
  const result = await runDigestControlPipeline({
    scope,
    lastDigest: lastDigestRow ? toCoreDigest(lastDigestRow) : null,
    prevState: prevDigestState,
    recentEvents,
    llm,
    prompts: {
      digestStage2SystemPrompt,
      digestStage2UserPrompt,
      digestClassifySystemPrompt,
      digestClassifyUserPrompt
    },
    config: {
      eventBudgetTotal: workerEnv.digestEventBudgetTotal,
      eventBudgetDocs: workerEnv.digestEventBudgetDocs,
      eventBudgetStream: workerEnv.digestEventBudgetStream,
      noveltyThreshold: workerEnv.digestNoveltyThreshold,
      maxRetries: workerEnv.digestMaxRetries,
      useLlmClassifier: workerEnv.digestUseLlmClassifier,
      debug: workerEnv.digestDebug
    },
    forgottenFactKeys
  });
```

- [ ] **Step 2: Build the worker**

Run: `pnpm --filter @statecore/worker build`
Expected: succeeds (the new param + Prisma `forgottenFact` model resolve).

- [ ] **Step 3: Run the worker test suite for regressions**

Run: `pnpm --filter @statecore/worker test`
Expected: existing worker tests stay green (a real Postgres test DB on localhost:5434 must be up for any DB-touching specs).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/main.ts
git commit -m "feat(worker): pass scope's forgotten-fact keys into the digest pipeline"
```

---

## Post-implementation verification

- `pnpm --filter @statecore/core test` and `pnpm --filter @statecore/worker test` green; `pnpm --filter @statecore/{core,worker} build` clean.
- Manual reasoning: forgetting a profile fact → its `factKey` is in `ForgottenFact` → next digest loads it → `pruneForgottenFacts` strips it from `state.profile`/`factRegistry` before `generateDigestStage2` → the regenerated summary and the written snapshot no longer contain it.

## Deploy (Droplet 1 — `ssh statecore`, `/root/StateCore`, TWO compose files)

After merge + push:
1. `cd /root/StateCore && git pull`.
2. NO migration (no schema change).
3. Rebuild the worker (it runs digests) — and api for a consistent image:
   `docker compose --env-file .env.production -f docker-compose.prod.yml -f compose.deploy.yml up -d --build worker api`
4. Smoke: worker boots clean (`docker compose ... logs worker | tail`); `/health` 200.

---

## Self-Review

**Spec coverage:** §1 `pruneForgottenFacts` pure fn → Task 1. §2 optional param + prune after merge before generate → Task 2. §3 worker loads keys + passes → Task 3. §4 effect (state+summary clean, both fact types) → covered by Tasks 1+2 (prune handles profile facets AND profile factRegistry). Backward-compat (default empty → unchanged) → Task 2 control test. No schema/migration → confirmed (no schema task). Testing → per-task. Key-computation-matches-display → Task 1 uses `computeFactKey(factToGroup(facet), content)`, identical to `flattenScopeFacts`.

**Placeholder scan:** none — concrete code/commands throughout.

**Type consistency:** `pruneForgottenFacts(state: DigestState, forgottenFactKeys: ReadonlySet<string>): void` consistent across Tasks 1/2/3; the pipeline param name `forgottenFactKeys` consistent in Tasks 2/3; `computeFactKey(factToGroup(facet), content)` consistent with the display path.
