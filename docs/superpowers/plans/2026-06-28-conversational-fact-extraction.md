# Conversational Fact Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the digest extract the Memory-screen's displayable profile facets (style/goals/relationships/followUps/ongoing) from conversation, so `GET /v1/memory/facts` populates.

**Architecture:** The clean extraction path is the generation LLM (`generateDigestStage2` → `profileFacts`) applied by `applyProfileFactsFromDigest`. Today both are wired to `identity`-only and documents-only. Generalize the apply logic to all displayable facets (with stream-event evidence), and rewrite the generation prompt to extract those facets from the conversation. The heuristic merge-routing path (`mergeProfileFacets`/`PROFILE_FACET_ROUTING`) is independently broken (its expected `classifiedType` vocabulary never matches the classifier output) and is left untouched — the generation path is the chosen, atomic-fact source.

**Tech Stack:** TypeScript, zod, vitest. Packages: `@statecore/core` (digest-control), `@statecore/prompts` (prompt strings). Digests run in `apps/worker`.

**Spec:** `docs/superpowers/specs/2026-06-28-conversational-fact-extraction-design.md`

## Global Constraints

- Tests run under **vitest** (`pnpm --filter @statecore/core test` / `pnpm --filter @statecore/api test`). Mirror existing tests in `packages/core/src/digest-state-profile.test.ts`.
- Displayable facets and the Memory-screen groups they map to (from `packages/core/src/memory-facts.ts` `FACET_TO_GROUP`, do NOT change): `style→Preferences`, `goals→Projects`, `ongoing→Projects`, `relationships→People`, `followUps→Schedule`. `identity` is extracted but never displayed.
- Per-facet caps (match the values already used by `mergeProfileFacets`/the state clamp): `identity 15, relationships 10, ongoing 8, goals 8, followUps 10, style 6`.
- Extraction is **aggressive**: capture durable things the user reveals (preferences/goals/people/commitments/ongoing). Noise is acceptable; `forget` removes unwanted entries. **Never invent** facts absent from the evidence.
- Evidence: identity uses document evidence (authority `0.85`, current behavior). Conversational facets use a stream-event ref (authority `0.6`) when no document is present; this keeps `factRegistry` + `forget` working and gives the fact a `createdAt`.
- Engine-only change. No cloud, no assistant-backend, no `FACET_TO_GROUP`, no document-ingestion changes. Leave `mergeProfileFacets`/`PROFILE_FACET_ROUTING` untouched.
- Deploy is Droplet 1 (engine **api + worker**); handled post-merge by the controller (not a subagent task).

---

### Task 1: Generalize `applyProfileFactsFromDigest` to all displayable facets

**Files:**
- Modify: `packages/core/src/digest-control.ts` (export + generalize `applyProfileFactsFromDigest`; thread stream evidence at the call site ~line 2229)
- Test: `packages/core/src/digest-state-profile.test.ts` (append cases)

**Interfaces:**
- Consumes: `sameFactCjkAware`, `promoteToFactRegistry`, `supersedeFact`, `createDefaultIdFactory`, `createDefaultNowFactory`, `DigestEvidenceRef`, `DigestState`, `MemoryEvent`, `DeltaCandidate.event` (all in `digest-control.ts`); `flattenScopeFacts` (`memory-facts.ts`).
- Produces: `export function applyProfileFactsFromDigest(state, profileFacts, documents, streamEvidence, makeId, makeNow?)` — now stores facets in `DISPLAY_FACETS = {identity, style, goals, relationships, followUps, ongoing}` into `state.profile[facet]` with dedup + caps + evidence.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/digest-state-profile.test.ts`:

```ts
import { applyProfileFactsFromDigest } from "./digest-control";
import { flattenScopeFacts } from "./memory-facts";

describe("applyProfileFactsFromDigest — conversational facets", () => {
  const streamEvidence = { id: "evt-1", sourceType: "event" as const };
  const ids = () => { let n = 0; return () => `id-${++n}`; };
  const now = () => "2026-06-28T00:00:00.000Z";

  function emptyState(): DigestState {
    return { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
  }

  it("stores each displayable facet into state.profile and surfaces it via flattenScopeFacts", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [
        { facet: "style", value: "喜欢 teal 色" },
        { facet: "goals", value: "想减肥" },
        { facet: "relationships", value: "妈妈住在上海" },
        { facet: "followUps", value: "周四 2 点看牙医" },
        { facet: "ongoing", value: "在做盲盒生意" }
      ],
      [],
      streamEvidence,
      ids(),
      now
    );
    expect(state.profile?.style).toContain("喜欢 teal 色");
    expect(state.profile?.goals).toContain("想减肥");
    expect(state.profile?.relationships).toContain("妈妈住在上海");
    expect(state.profile?.followUps).toContain("周四 2 点看牙医");
    expect(state.profile?.ongoing).toContain("在做盲盒生意");

    const groups = Object.fromEntries(
      flattenScopeFacts(state).map((f) => [f.text, f.group])
    );
    expect(groups["喜欢 teal 色"]).toBe("Preferences");
    expect(groups["想减肥"]).toBe("Projects");
    expect(groups["妈妈住在上海"]).toBe("People");
    expect(groups["周四 2 点看牙医"]).toBe("Schedule");
  });

  it("ignores unknown facets and empty values", () => {
    const state = emptyState();
    applyProfileFactsFromDigest(
      state,
      [{ facet: "weather", value: "sunny" }, { facet: "style", value: "  " }],
      [], streamEvidence, ids(), now
    );
    expect(flattenScopeFacts(state)).toHaveLength(0);
  });

  it("dedups near-duplicate facts within a facet", () => {
    const state = emptyState();
    const make = ids();
    applyProfileFactsFromDigest(state, [{ facet: "style", value: "喜欢 teal 色" }], [], streamEvidence, make, now);
    applyProfileFactsFromDigest(state, [{ facet: "style", value: "喜欢 teal 色" }], [], streamEvidence, make, now);
    expect(state.profile?.style).toHaveLength(1);
  });

  it("enforces the per-facet cap (style = 6)", () => {
    const state = emptyState();
    const make = ids();
    for (let i = 0; i < 9; i += 1) {
      applyProfileFactsFromDigest(state, [{ facet: "style", value: `pref-${i}` }], [], streamEvidence, make, now);
    }
    expect(state.profile?.style?.length).toBeLessThanOrEqual(6);
  });

  it("still applies identity from documents (regression)", () => {
    const state = emptyState();
    const doc = { id: "doc-1", scopeId: "s", type: "document", source: "api", key: "resume", content: "resume", createdAt: new Date() } as unknown as MemoryEvent;
    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "工作经历: 字节跳动 后端 2019-2022" }],
      [doc], null, ids(), now
    );
    expect(state.profile?.identity).toContain("工作经历: 字节跳动 后端 2019-2022");
  });
});
```

(Add `MemoryEvent` to the existing `import { ... } from "./digest-control"` line if not already imported.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @statecore/core test -- digest-state-profile`
Expected: FAIL — `applyProfileFactsFromDigest` is not exported.

- [ ] **Step 3: Generalize the function**

In `packages/core/src/digest-control.ts`, add these consts just above `function applyProfileFactsFromDigest`:

```ts
const DISPLAY_FACETS = new Set(["identity", "style", "goals", "relationships", "followUps", "ongoing"]);
const PROFILE_FACET_CAPS: Record<string, number> = {
  identity: 15, relationships: 10, ongoing: 8, goals: 8, followUps: 10, style: 6
};
```

Replace the whole `function applyProfileFactsFromDigest(...) { ... }` (currently identity-only, ~lines 1147-1205) with this generalized, exported version:

```ts
export function applyProfileFactsFromDigest(
  state: DigestState,
  profileFacts: { facet: string; value: string }[],
  documents: MemoryEvent[],
  streamEvidence: DigestEvidenceRef | null,
  makeId: () => string,
  makeNow: () => string = createDefaultNowFactory()
): void {
  if (profileFacts.length === 0) return;
  if (!state.profile) state.profile = {};

  const latestDoc = documents.length > 0 ? documents[documents.length - 1] : null;
  const docEvidence: DigestEvidenceRef | null = latestDoc
    ? { id: latestDoc.id, sourceType: "document", key: latestDoc.key ?? undefined }
    : null;

  for (const pf of profileFacts) {
    const facet = pf.facet.trim();
    const value = pf.value.trim();
    if (!value || !DISPLAY_FACETS.has(facet)) continue;

    // identity is document-authority; conversational facets prefer a document ref if one
    // exists this window, else the stream-event ref.
    const evidence: DigestEvidenceRef | null =
      facet === "identity" ? docEvidence : (docEvidence ?? streamEvidence);
    const authority = evidence?.sourceType === "document" ? 0.85 : 0.6;
    const cap = PROFILE_FACET_CAPS[facet] ?? 8;

    const profileMap = state.profile as Record<string, string[]>;
    if (!profileMap[facet]) profileMap[facet] = [];
    const facetFacts = profileMap[facet];

    const existingIdx = facetFacts.findIndex((fact) => sameFactCjkAware(fact, value, 0.6));
    if (existingIdx !== -1) {
      const existing = facetFacts[existingIdx];
      if (evidence) {
        supersedeFact(state, existing, value, evidence, makeId, { facet, confidence: authority, type: "profile" }, makeNow);
      }
      facetFacts[existingIdx] = value;
      continue;
    }

    if (facetFacts.length >= cap) {
      if (facet === "identity") continue; // identity is high-value; don't evict to add
      facetFacts.splice(0, 1); // volatile facets: evict oldest (index 0)
    }

    facetFacts.push(value);
    if (evidence) {
      promoteToFactRegistry(state, value, "profile", authority, evidence, makeId, facet, makeNow);
    }
  }
}
```

- [ ] **Step 4: Thread stream evidence at the call site**

In `packages/core/src/digest-control.ts`, find the call (~line 2229):

```ts
  if (digest.profileFacts && digest.profileFacts.length > 0) {
    applyProfileFactsFromDigest(state, digest.profileFacts, selection.documents, createDefaultIdFactory(), createDefaultNowFactory());
  }
```

Replace it with (derive the latest stream event from the delta candidates as evidence):

```ts
  if (digest.profileFacts && digest.profileFacts.length > 0) {
    const streamEvents = deltas.map((d) => d.event).filter(Boolean);
    const latestStream = streamEvents.length > 0 ? streamEvents[streamEvents.length - 1] : null;
    const streamEvidence: DigestEvidenceRef | null = latestStream
      ? { id: latestStream.id, sourceType: "event" }
      : null;
    applyProfileFactsFromDigest(state, digest.profileFacts, selection.documents, streamEvidence, createDefaultIdFactory(), createDefaultNowFactory());
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @statecore/core test -- digest-state-profile`
Expected: PASS (all new cases + the pre-existing profile round-trip cases).

- [ ] **Step 6: Run the full core suite (no regressions)**

Run: `pnpm --filter @statecore/core test`
Expected: PASS — existing digest-control / profile / fact-registry tests stay green (the change is additive: identity behavior preserved, other facets newly handled).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/digest-control.ts packages/core/src/digest-state-profile.test.ts
git commit -m "feat(digest): apply all displayable profile facets (not just identity)"
```

---

### Task 2: Rewrite the digest extraction prompt for conversational facets

**Files:**
- Modify: `packages/prompts/src/index.ts` (`digestStage2SystemPrompt`, `digestStage2UserPrompt`)
- Test: any prompt snapshot/contract test that asserts these strings (search before editing)

**Interfaces:**
- Consumes: nothing new. Produces the prompt strings `generateDigestStage2` feeds the LLM; the LLM must emit `profileFacts: [{facet, value}]` using the facet names Task 1 stores (`style/goals/relationships/followUps/ongoing/identity`).

- [ ] **Step 1: Find any test asserting the prompt text**

Run: `grep -rn "Extract ONLY from document bodies\|digestStage2SystemPrompt\|profileFacts" packages --include=*.test.ts`
Note any snapshot/contract test that pins the prompt; it must be updated in Step 4. (If none, there is no snapshot to update.)

- [ ] **Step 2: Rewrite `digestStage2SystemPrompt`**

In `packages/prompts/src/index.ts`, replace the single `- profileFacts: ...` line in `digestStage2SystemPrompt` with this block (keep every other rule line unchanged):

```
- profileFacts: array of {facet, value} pairs extracted from the conversation (Delta candidates) AND any documents. Aggressively capture durable things the user reveals about themselves. Allowed facets:
  - "style": preferences, tastes, communication style (e.g. "喜欢 teal 色", "偏好简洁的回答", "口味偏辣").
  - "goals": things the user wants to achieve (e.g. "想减肥", "7 月上线 Remi").
  - "relationships": important people in the user's life (e.g. "妈妈住在上海", "同事 Alex 负责后端").
  - "followUps": commitments or things to remember/do (e.g. "周四 2 点看牙医", "给供应商打电话问 Q3").
  - "ongoing": projects or activities in progress (e.g. "在做盲盒生意", "在学西班牙语").
  - "identity": durable personal facts from documents (resume/bio): 工作经历, 教育, 技能, 联系方式.
  Each value is a self-contained fact line in the user's own language. Prefer the user's own statements over the assistant's. Extract whenever the user reveals such info; omit profileFacts only when the conversation reveals none. Do not invent facts not present in the evidence.
```

- [ ] **Step 3: Update `digestStage2UserPrompt`**

In the same file, replace the trailing two lines of `digestStage2UserPrompt`:

```
goal: one-line restatement of the scope goal (use the Goal field above verbatim if unchanged).
profileFacts: only include when Latest documents contain personal identity data (resume, bio). Use facet "identity".
```

with:

```
goal: one-line restatement of the scope goal (use the Goal field above verbatim if unchanged).
profileFacts: extract from Delta candidates (conversation) and documents using the allowed facets (style, goals, relationships, followUps, ongoing, identity). Capture durable user-revealed facts; omit only if none are present.
```

- [ ] **Step 4: Update any pinned prompt test**

If Step 1 found a snapshot/contract test asserting the old prompt text, update its expected value to the new text (or re-bless the snapshot). If none was found, skip.

- [ ] **Step 5: Run the prompts + core tests**

Run: `pnpm --filter @statecore/prompts test && pnpm --filter @statecore/core test`
Expected: PASS (prompts package green; core unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/prompts/src/index.ts
git commit -m "feat(prompts): extract conversational profile facets in digest stage 2"
```

---

## Final verification (after both tasks)

- [ ] `pnpm --filter @statecore/core test && pnpm --filter @statecore/prompts test && pnpm --filter @statecore/api test` — all green.
- [ ] `pnpm -r build` (or the repo's build) — clean compile (the `applyProfileFactsFromDigest` export + signature change compiles across packages).

## Post-implementation: deploy & backfill (controller, not a subagent task)

After review + merge, on Droplet 1 (`ssh statecore`, both compose files):
1. `git pull` then rebuild **api + worker**: `docker compose --env-file .env.production -f docker-compose.prod.yml -f compose.deploy.yml up -d --build api worker`.
2. **Backfill** the live scope so existing conversation re-extracts: `POST /v1/memory/digest/rebuild { scopeId }` (or `/v1/memory/digest`) via the public API with the `sc_live_` key. Wait for the worker to finish, then confirm `GET /v1/memory/facts?scopeId=…` returns non-empty groups.
3. The Remi app Memory screen should then show Preferences/People/Projects/Schedule.

## Notes / known limitations (for the final reviewer)

- The heuristic merge path (`mergeProfileFacets` + `PROFILE_FACET_ROUTING`) is left untouched: its expected `classifiedType` vocabulary (`personal_detail/goal/life_decision/experience/person_note/commitment/style_preference`) never matches the classifier output (`decision/constraint/todo/note/status/question/noise`), so it is a no-op today. The generation-LLM path is the chosen atomic-fact source; aligning/repairing that routing is a separate future effort.
- Stream-fact evidence is the latest delta event in the digest window (best-effort), so a fact's `evidenceId` may not point to the exact originating turn. `forget` still works by `factKey` (ForgottenFact + prune) regardless.
- Aggressive extraction may capture personal/health goals the user shared (e.g. weight loss); removal is via `forget` (per spec, no sensitive-topic redaction in v1).
