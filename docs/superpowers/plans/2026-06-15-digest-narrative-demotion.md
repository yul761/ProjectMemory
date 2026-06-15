# Digest LLM Narrative Demotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demote the LLM from writing a full digest summary to writing only a short session narrative, while ensuring the state-projected prefix (goal, constraints, decisions) is always prepended by code and the narrative appended after it.

**Architecture:** Two tasks. Task 1 fixes `buildProjectedSummary` to append the narrative AFTER the state prefix instead of discarding it, with unit tests through `generateDigestStage2`. Task 2 updates the prompt templates and removes the unused `goal` field from `DigestOutputSchema`. Together they ensure: LLM writes ≤50-word narrative → code prepends "Goal: X. Constraints: Y. Decisions: Z." → aligned summary = state facts + LLM narrative.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. No new dependencies.

---

## File Map

| File | Action |
|------|--------|
| `packages/core/src/digest-control.ts` | Modify — `buildProjectedSummary` append narrative; remove `goal` from `DigestOutput` interface + `DigestOutputSchema`; clean `generateDigestStage2` return |
| `packages/core/src/digest-control.test.ts` | Modify — add tests for narrative-in-summary behavior |
| `packages/prompts/src/templates/digest.stage2.system.txt` | Modify — demote LLM to narrative-only writer |
| `packages/prompts/src/templates/digest.stage2.user.txt` | Modify — remove `goal` from JSON output format, clarify narrative role |

---

## Orientation: What the code currently does

`buildProjectedSummary(state, fallbackSummary)` at line ~1419:
```typescript
function buildProjectedSummary(state: DigestState, fallbackSummary: string) {
  const parts: string[] = [];
  // ... build state prefix: "Goal: X. Constraints: A. Decisions: Y."
  const projected = parts.join(" ").trim();
  if (projected) return projected;   // ← DISCARDS fallbackSummary when state has content
  // fallback only when state is empty
  let summary = fallbackSummary.trim()...
  return summaryWithGoal.trim();
}
```

**The bug:** When state has content, the LLM-written summary is silently discarded. Users never see what the LLM observed about the session.

**The fix:** After building the state prefix, *attempt* to append the narrative using `appendSummarySentence` (which enforces the 120-word cap). If there's room, the narrative appears. If not, only the state prefix shows.

---

## Task 1: Fix buildProjectedSummary + tests

**Files:**
- Modify: `packages/core/src/digest-control.ts` (~line 1419)
- Modify: `packages/core/src/digest-control.test.ts`

### Step 1: Write failing tests

In `packages/core/src/digest-control.test.ts`, find the `generateDigestStage2` describe block and add these tests **before** the existing tests (so you can run just these first):

```typescript
it("appends LLM narrative to state-projected summary when both are present", async () => {
  const llm = {
    chat: async () => JSON.stringify({
      summary: "Session focused on benchmarking the digest pipeline.",
      changes: [],
      nextSteps: ["review metrics"]
    })
  };

  const result = await generateDigestStage2({
    scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
    lastDigest: null,
    protectedState: {
      stableFacts: { goal: "ship alpha", constraints: ["no paid APIs"], decisions: [] },
      workingNotes: {},
      todos: []
    },
    deltaCandidates: [],
    documents: [],
    llm,
    systemPrompt: "system",
    userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
    maxRetries: 0
  });

  // State prefix must appear
  expect(result.summary).toContain("Goal: ship alpha");
  expect(result.summary).toContain("no paid APIs");
  // Narrative must ALSO appear (not discarded)
  expect(result.summary).toContain("benchmarking");
  // Total word count must be ≤120
  expect(result.summary.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
});

it("uses narrative alone when state has no goal or constraints", async () => {
  const llm = {
    chat: async () => JSON.stringify({
      summary: "Initial session to set up the project scope.",
      changes: [],
      nextSteps: ["define goal"]
    })
  };

  const result = await generateDigestStage2({
    scope: { id: "s", userId: "u", name: "Demo", goal: "", stage: "idea", createdAt: new Date() },
    lastDigest: null,
    protectedState: {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: []
    },
    deltaCandidates: [],
    documents: [],
    llm,
    systemPrompt: "system",
    userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
    maxRetries: 0
  });

  expect(result.summary).toContain("Initial session");
});
```

### Step 2: Run to verify they fail

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test -- digest-control 2>&1 | Select-Object -Last 20
```

Expected: Test 1 fails — "benchmarking" NOT in result.summary (currently discarded). Test 2 may pass already.

### Step 3: Fix buildProjectedSummary

In `packages/core/src/digest-control.ts`, find `buildProjectedSummary` (around line 1419). Replace the entire function:

```typescript
function buildProjectedSummary(state: DigestState, narrative: string) {
  const parts: string[] = [];

  if (state.stableFacts.goal) {
    appendSummarySentence(parts, `Goal: ${state.stableFacts.goal}.`);
  }
  const constraints = state.stableFacts.constraints ?? [];
  if (constraints.length) {
    for (let count = constraints.length; count >= 1; count -= 1) {
      const sentence = `Constraints: ${constraints.slice(0, count).join("; ")}.`;
      const before = parts.length;
      appendSummarySentence(parts, sentence);
      if (parts.length > before) break;
    }
  }
  const decisions = state.stableFacts.decisions ?? [];
  if (decisions.length) {
    const recentDecisions = decisions.slice(-8);
    for (let count = recentDecisions.length; count >= 1; count -= 1) {
      const sentence = `Decisions: ${recentDecisions.slice(-count).join("; ")}.`;
      const before = parts.length;
      appendSummarySentence(parts, sentence);
      if (parts.length > before) break;
    }
  }

  const openQuestion = state.workingNotes.openQuestions?.[0];
  if (openQuestion) {
    appendSummarySentence(parts, `Open question: ${openQuestion}.`);
  }
  const risk = state.workingNotes.risks?.[0];
  if (risk) {
    appendSummarySentence(parts, `Active risk: ${risk}.`);
  }

  // Append narrative after state prefix (if there is room within 120 words)
  const trimmedNarrative = narrative.trim();
  if (trimmedNarrative) {
    appendSummarySentence(parts, trimmedNarrative);
  }

  const result = parts.join(" ").trim();
  if (result) return result;

  // Fallback: state is empty, return narrative alone
  return trimmedNarrative;
}
```

**Note:** The only change from the original is:
1. Parameter renamed from `fallbackSummary` to `narrative` (semantic clarity)
2. `appendSummarySentence(parts, trimmedNarrative)` called BEFORE `return projected`
3. Final `return result` instead of the old fallback logic (cleaner)

### Step 4: Run tests to verify they pass

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 10
```

Expected: All 157+ tests pass including the 2 new ones.

If test 1 still fails (narrative not appearing): check that `appendSummarySentence` is called after building the state parts. The state prefix "Goal: ship alpha. Constraints: no paid APIs." is ~7 words — "Session focused on benchmarking the digest pipeline." is 7 more = ~14 total, well within 120.

### Step 5: Commit

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "fix(digest): append LLM narrative to state-projected summary instead of discarding it"
```

---

## Task 2: Update prompts + remove goal from schema

**Files:**
- Modify: `packages/prompts/src/templates/digest.stage2.system.txt`
- Modify: `packages/prompts/src/templates/digest.stage2.user.txt`
- Modify: `packages/core/src/digest-control.ts` — `DigestOutput` interface + `DigestOutputSchema` + `generateDigestStage2`

### Step 1: Update system prompt

Replace `packages/prompts/src/templates/digest.stage2.system.txt` entirely:

```
You are a long-term memory engine assistant. Write a brief session narrative.
Rules:
- Output JSON only.
- summary: 1-3 sentences (<=50 words) describing what happened this session. Do NOT include goal, constraints, or decisions in summary — these are managed separately and will be prepended automatically.
- changes: <=3 bullets of notable events or observations from this session (not goal/constraints/decisions which appear automatically).
- nextSteps: 1-3 concrete new action items discovered this session (not existing todos which appear automatically).
- Do not invent facts not present in the provided evidence.
```

### Step 2: Update user prompt template

Replace `packages/prompts/src/templates/digest.stage2.user.txt` entirely:

```
Context:
Scope: {{scopeName}}
Stage: {{scopeStage}}

Established context (do not repeat in summary or changes):
Goal: {{scopeGoal}}
Protected state: {{protectedState}}

Previous digest:
{{lastDigest}}

New events this session:
{{deltaCandidates}}

Latest documents:
{{documents}}

Return JSON: {"summary": string, "changes": string[], "nextSteps": string[]}
summary: 1-3 sentences about what happened this session. No goal, constraints, or decisions — those are prepended automatically.
```

**Note:** Removed `"goal": string` from JSON output format. Added explicit "do not repeat" instruction for established context.

### Step 3: Remove goal from DigestOutput interface and schema

In `packages/core/src/digest-control.ts`:

**Find and replace the DigestOutput interface** (around line 115):

```typescript
// Before:
export interface DigestOutput {
  goal?: string;
  summary: string;
  changes: string[];
  nextSteps: string[];
}

// After:
export interface DigestOutput {
  summary: string;
  changes: string[];
  nextSteps: string[];
}
```

**Find and replace DigestOutputSchema** (around line 128):

```typescript
// Before:
export const DigestOutputSchema = z.object({
  goal: z.string().optional(),
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string())
});

// After:
export const DigestOutputSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string())
});
```

### Step 4: Clean generateDigestStage2 return value

In `packages/core/src/digest-control.ts`, find `generateDigestStage2`. It currently returns `{ ...aligned, goal: validated.data.goal }`. Remove the `goal` spread.

Find this pattern (around line 1750-1755):
```typescript
return {
  ...aligned,
  goal: validated.data.goal
};
```

Replace with:
```typescript
return aligned;
```

If the function has multiple return points, search for `goal: validated.data.goal` and remove that property from all return statements.

### Step 5: Run full test suite

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 12
```

Expected: All tests pass. No test should reference `result.goal` from `generateDigestStage2` — confirm by checking if any existing test asserts on a `goal` field from the result.

If a test fails because it checks `result.goal`:
- Find the test
- Remove the `.goal` assertion (since goal is now always taken from protectedState, not LLM output)

### Step 6: Verify prompt change doesn't break the no-change digest test

The existing test "returns no-change digest when only repeated changes are detected" uses:
```typescript
chat: async () => "{\"summary\":\"ok\",\"changes\":[\"same change\"],\"nextSteps\":[\"Test pipeline\"]}"
```

This has no `goal` field — it already works with the new schema. Confirm it still passes.

### Step 7: Commit and push

```powershell
cd C:\StateCore\StateCore
git add packages/prompts/src/templates/digest.stage2.system.txt \
        packages/prompts/src/templates/digest.stage2.user.txt \
        packages/core/src/digest-control.ts
git commit -m "feat(digest): demote LLM to narrative-only — goal/constraints/decisions from state only"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Requirement | Task |
|------------|------|
| LLM writes narrative only (≤50 words, no facts) | Task 2 prompts ✅ |
| `buildProjectedSummary` appends narrative AFTER state prefix | Task 1 ✅ |
| Remove `goal` from `DigestOutputSchema` | Task 2 ✅ |
| Remove `goal` from `DigestOutput` interface | Task 2 ✅ |
| Remove `goal: validated.data.goal` from return | Task 2 ✅ |
| Tests verify narrative appears in aligned summary | Task 1 ✅ |
| Tests verify narrative alone when state empty | Task 1 ✅ |

**Placeholder scan:** None found.

**Type consistency:**
- `buildProjectedSummary(state, narrative)` — parameter name changed from `fallbackSummary` to `narrative`. Called from `alignDigestWithState(output, state)` as `buildProjectedSummary(state, output.summary)` — no change needed since `output.summary` is now the narrative. ✅
- `DigestOutput.goal` removed from interface — `generateDigestStage2` return changed from `{ ...aligned, goal }` to `aligned`. Callers that accessed `.goal` on the return will get TypeScript errors — search for `.goal` in test/API code if tests fail. ✅
- `DigestOutputSchema` no longer has `goal` field — LLM responses that include `goal` are still parsed correctly (Zod strips unknown fields by default). ✅

**One important backward compatibility note:**
`consistencyCheck` checks `parseGoal(input.output.summary)`. After this change, `output.summary` is the ALIGNED summary (state prefix + narrative). The aligned summary starts with "Goal: X." which `parseGoal` can parse. Since the goal in the summary always comes from `buildProjectedSummary` (which uses `state.stableFacts.goal`), `goal_contradiction` will never trigger in practice. The check is now a defense layer against edge cases where `buildProjectedSummary` somehow produces a wrong goal — keep it as-is, no changes needed.
