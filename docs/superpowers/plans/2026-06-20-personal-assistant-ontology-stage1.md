# Personal-Assistant State Ontology — Stage 1 (Identity/Profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan. Steps use checkbox (`- [ ]`) syntax. Execute all tasks in order (Task 1 → 6). Each task ends with a passing vitest run and a git commit before the next begins.

## Goal

Fix Probe B2 (§15 of design spec): resume fact `字节跳动` must appear in the runtime State block every turn. Root cause: `DigestState` has no `profile` container; `classifiedType==="personal_detail"` events are silently ignored by digest; `formatStateLayerView` renders only 6 PM slots.

Stage 1 scope: **identity/profile facet only** (`personal_detail` → `profile.identity`; doc→identity LLM extraction; identity write-protection; rendering; Zod contracts). Stages 2 and 3 (goals/ongoing/relationships/followUps routing) are explicitly out of scope.

## Architecture

```
MemoryEvent.classifiedType ──────► mergeProfileFacets() ──► DigestState.profile.identity
                                   (stream, Task 3)          (capped 15, write-protected)

LLM digest output.profileFacts ──► applyProfileFactsFromDigest() ──► DigestState.profile.identity
                                   (doc authority 0.85, Task 4)       (write-protected, 0.85 conf)

DigestState.profile ─────────────► compileStateLayerView() ──► StateLayerView.identity
                                   (Task 1)

StateLayerView.identity ─────────► formatStateLayerView() ──► "你是谁/档案:" section
                                   (Task 1)

factRegistry[facet="identity"] ──► consistencyCheck() ──► "profile_identity_contradiction"
                                   (Task 5)
```

## Tech Stack

- TypeScript / NestJS / Prisma
- Vitest for unit/integration tests
- Node toolchain: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"` before any `pnpm` commands
- Tests: `pnpm --filter @statecore/core test -- <pattern>`

## Global Constraints (from spec §2, §3, §5, §7, §8, §9 — non-negotiable)

- **Additive only**: do NOT remove or alter existing 6 PM slots (`goal`, `constraints`, `decisions`, `todos`, `openQuestions`, `risks`); project-template behaviour is unchanged.
- **Reuse fact-registry**: write-protection for identity/goals uses `factRegistry` + `facet` tag; no new protection mechanism.
- **Per-facet cap**: identity=15. Write-protected entries are **never** evicted; only unprotected entries are displaced when cap is reached.
- **Jaccard only**: use the `tokenize`/`jaccardSimilarity` at `digest-control.ts:343–363` (the correct `\s` tokeniser). Do NOT use the retrieval tokeniser.
- **Benchmark must not regress**: `consistencyPassRate` and `goldRetention` scores must hold after each task; check with `node scripts/benchmark/run-benchmark.mjs` (requires live API).
- **No Stage 2/3 code**: relationships, ongoing, goals, followUps routing are NOT implemented here; only their optional fields are declared in types.
- **Existing 27 core test files must stay green** after every commit.

---

## Task 1 — `StateLayerView` Rendering

### Files

| Role | Path | Lines touched |
|---|---|---|
| Modify | `packages/core/src/working-memory.compiler.ts` | 3–14, 25–32, 45–53, 77–87 |
| Test (new) | `packages/core/src/working-memory.compiler.test.ts` | — |

### Interfaces

**Consumes:** `PartialDigestState.profile?.identity?: string[]` (and other facets, declared but empty in Stage 1)
**Produces:** `StateLayerView.identity?: string[]` → `formatStateLayerView` section `"你是谁/档案:"`

### Steps

- [ ] **1.1 Write failing test** — create `packages/core/src/working-memory.compiler.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { compileStateLayerView, formatStateLayerView } from "./working-memory.compiler";

describe("formatStateLayerView — profile sections", () => {
  it("renders identity facts under '你是谁/档案:'", () => {
    const view = compileStateLayerView({
      profile: {
        identity: ["工作经历: 字节跳动 后端工程师 2019-2022", "教育: 北京大学 计算机科学 2015-2019"]
      }
    });
    const text = formatStateLayerView(view);
    expect(text).toContain("你是谁/档案:");
    expect(text).toContain("- 工作经历: 字节跳动 后端工程师 2019-2022");
    expect(text).toContain("- 教育: 北京大学 计算机科学 2015-2019");
  });

  it("project-template non-regression: 6 PM slots present, no profile sections", () => {
    const view = compileStateLayerView({
      stableFacts: {
        goal: "ship API",
        constraints: ["keep stable"],
        decisions: ["use postgres"]
      },
      todos: ["write docs"],
      workingNotes: {
        openQuestions: ["timeline?"],
        risks: ["vendor lock"]
      }
    });
    const text = formatStateLayerView(view);
    expect(text).toContain("Stable goal: ship API");
    expect(text).toContain("Stable constraints:");
    expect(text).toContain("Stable decisions:");
    expect(text).toContain("Durable todos:");
    expect(text).toContain("Open questions:");
    expect(text).toContain("Risks:");
    expect(text).not.toContain("你是谁");
    expect(text).not.toContain("人际");
    expect(text).not.toContain("正在经历");
    expect(text).not.toContain("目标");
    expect(text).not.toContain("待跟进");
  });

  it("empty identity array produces no section (pushSection guard)", () => {
    const view = compileStateLayerView({
      profile: { identity: [] }
    });
    const text = formatStateLayerView(view);
    expect(text).not.toContain("你是谁");
  });
});
```

- [ ] **1.2 Confirm test fails**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "working-memory.compiler"
```

Expected: 3 failures (`TypeError: compileStateLayerView called with unknown property profile`; rendering assertions fail).

- [ ] **1.3 Implement** — edit `packages/core/src/working-memory.compiler.ts`:

**a) Extend `PartialDigestState` (lines 3–14) — add `profile?`:**

Replace:
```typescript
type PartialDigestState = {
  stableFacts?: {
    goal?: string;
    constraints?: string[];
    decisions?: string[];
  };
  todos?: string[];
  workingNotes?: {
    openQuestions?: string[];
    risks?: string[];
  };
} | null;
```
With:
```typescript
type PartialDigestState = {
  stableFacts?: {
    goal?: string;
    constraints?: string[];
    decisions?: string[];
  };
  todos?: string[];
  workingNotes?: {
    openQuestions?: string[];
    risks?: string[];
  };
  profile?: {
    identity?: string[];
    relationships?: string[];
    ongoing?: string[];
    goals?: string[];
    followUps?: string[];
  };
} | null;
```

**b) Extend `StateLayerView` interface (lines 25–32) — add 5 optional profile fields:**

Replace:
```typescript
export interface StateLayerView {
  goal?: string;
  constraints: string[];
  decisions: string[];
  todos: string[];
  openQuestions: string[];
  risks: string[];
}
```
With:
```typescript
export interface StateLayerView {
  goal?: string;
  constraints: string[];
  decisions: string[];
  todos: string[];
  openQuestions: string[];
  risks: string[];
  identity?: string[];
  relationships?: string[];
  ongoing?: string[];
  goals?: string[];
  followUps?: string[];
}
```

**c) Update `compileStateLayerView` (lines 45–53) — populate profile fields:**

Replace:
```typescript
export function compileStateLayerView(state?: PartialDigestState): StateLayerView {
  return {
    goal: state?.stableFacts?.goal,
    constraints: state?.stableFacts?.constraints ?? [],
    decisions: state?.stableFacts?.decisions ?? [],
    todos: state?.todos ?? [],
    openQuestions: state?.workingNotes?.openQuestions ?? [],
    risks: state?.workingNotes?.risks ?? []
  };
}
```
With:
```typescript
export function compileStateLayerView(state?: PartialDigestState): StateLayerView {
  return {
    goal: state?.stableFacts?.goal,
    constraints: state?.stableFacts?.constraints ?? [],
    decisions: state?.stableFacts?.decisions ?? [],
    todos: state?.todos ?? [],
    openQuestions: state?.workingNotes?.openQuestions ?? [],
    risks: state?.workingNotes?.risks ?? [],
    identity: state?.profile?.identity,
    relationships: state?.profile?.relationships,
    ongoing: state?.profile?.ongoing,
    goals: state?.profile?.goals,
    followUps: state?.profile?.followUps
  };
}
```

**d) Update `formatStateLayerView` (lines 77–87) — render profile sections after existing slots:**

Replace:
```typescript
export function formatStateLayerView(view?: StateLayerView | null) {
  if (!view) return "(none)";
  const lines = [];
  if (view.goal) lines.push(`Stable goal: ${view.goal}`);
  pushSection(lines, "Stable constraints", view.constraints);
  pushSection(lines, "Stable decisions", view.decisions);
  pushSection(lines, "Durable todos", view.todos);
  pushSection(lines, "Open questions", view.openQuestions);
  pushSection(lines, "Risks", view.risks);
  return lines.length ? lines.join("\n") : "(none)";
}
```
With:
```typescript
export function formatStateLayerView(view?: StateLayerView | null) {
  if (!view) return "(none)";
  const lines = [];
  if (view.goal) lines.push(`Stable goal: ${view.goal}`);
  pushSection(lines, "Stable constraints", view.constraints);
  pushSection(lines, "Stable decisions", view.decisions);
  pushSection(lines, "Durable todos", view.todos);
  pushSection(lines, "Open questions", view.openQuestions);
  pushSection(lines, "Risks", view.risks);
  pushSection(lines, "你是谁/档案", view.identity);
  pushSection(lines, "人际", view.relationships);
  pushSection(lines, "正在经历", view.ongoing);
  pushSection(lines, "目标", view.goals);
  pushSection(lines, "待跟进", view.followUps);
  return lines.length ? lines.join("\n") : "(none)";
}
```

- [ ] **1.4 Confirm tests pass**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "working-memory.compiler"
```

Expected: 3/3 green. Also run full suite to confirm no regressions:

```bash
pnpm --filter @statecore/core test
```

Expected: all existing tests still pass (the `fast-layer-context.compiler.test.ts` uses `StateLayerView` shape — verify it still type-checks and passes).

- [ ] **1.5 Commit**:

```bash
git add packages/core/src/working-memory.compiler.ts packages/core/src/working-memory.compiler.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): add profile fields to StateLayerView and formatStateLayerView

Adds 5 optional profile facet fields (identity, relationships, ongoing,
goals, followUps) to PartialDigestState, StateLayerView interface,
compileStateLayerView, and formatStateLayerView. Empty facets are skipped
by the existing pushSection guard; project-template rendering unchanged.
Stage 1 of personal-assistant state ontology (§6 spec).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Types & Contracts

### Files

| Role | Path | Lines touched |
|---|---|---|
| Modify | `packages/core/src/digest-control.ts` | 14–49 (`DigestState`), 51–60 (`FactRegistryEntry`), 233–283 (`normalizeDigestState`) |
| Modify | `packages/contracts/src/index.ts` | 274–281 (`StateLayerView` Zod), 388–491 (`DigestState` Zod) |
| Test (new) | `packages/core/src/digest-state-profile.test.ts` | — |

### Interfaces

**Consumes:** `DigestState` (internal TS type in `digest-control.ts`), `DigestState` Zod (in `contracts/index.ts`)
**Produces:**
- `DigestState.profile?: { identity?: string[]; relationships?: string[]; ongoing?: string[]; goals?: string[]; followUps?: string[] }`
- `FactRegistryEntry.type` includes `"profile"`; `FactRegistryEntry.facet?: string`
- `normalizeDigestState` preserves `profile` through JSON round-trip
- Zod `DigestState` and `StateLayerView` accept `profile?` — `safeParse` succeeds

### Steps

- [ ] **2.1 Write failing test** — create `packages/core/src/digest-state-profile.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { normalizeDigestState, type DigestState } from "./digest-control";
import { DigestState as DigestStateZod, StateLayerView as StateLayerViewZod } from "@statecore/contracts";

describe("DigestState profile — types and contracts", () => {
  it("DigestState with profile round-trips through normalizeDigestState without data loss", () => {
    const state: DigestState = {
      stableFacts: { decisions: [], goal: "find a job" },
      workingNotes: {},
      todos: [],
      factRegistry: [],
      profile: {
        identity: ["工作经历: 字节跳动 后端工程师 2019-2022"],
        relationships: [],
        ongoing: [],
        goals: [],
        followUps: []
      }
    };
    const normalized = normalizeDigestState(state);
    expect(normalized.profile?.identity).toEqual(["工作经历: 字节跳动 后端工程师 2019-2022"]);
  });

  it("DigestState with profile and facet-tagged factRegistry entry round-trips through Zod schema", () => {
    const raw = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      profile: {
        identity: ["工作经历: 字节跳动 后端工程师 2019-2022"]
      }
    };
    const result = DigestStateZod.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile?.identity?.[0]).toBe("工作经历: 字节跳动 后端工程师 2019-2022");
    }
  });

  it("StateLayerView Zod schema accepts identity field", () => {
    const raw = {
      goal: "find a job",
      constraints: [],
      decisions: [],
      todos: [],
      openQuestions: [],
      risks: [],
      identity: ["工作经历: 字节跳动 后端工程师 2019-2022"]
    };
    const result = StateLayerViewZod.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.identity?.[0]).toBe("工作经历: 字节跳动 后端工程师 2019-2022");
    }
  });
});
```

- [ ] **2.2 Confirm test fails**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "digest-state-profile"
```

Expected: TypeScript errors on `profile` property (unknown on `DigestState`); Zod safeParse failures.

- [ ] **2.3 Implement** — make changes in order:

**a) `packages/core/src/digest-control.ts` — extend `DigestState` interface (lines 14–49):**

Replace:
```typescript
export interface DigestState {
  stableFacts: {
    goal?: string;
    constraints?: string[];
    decisions: string[];
  };
  workingNotes: {
    openQuestions?: string[];
    risks?: string[];
    context?: string;
  };
  todos: string[];
  volatileContext?: string[];
  evidenceRefs?: DigestEvidenceRef[];
  confidence?: {
    goal?: number;
    constraints?: DigestStateValueConfidence[];
    decisions?: DigestStateValueConfidence[];
    todos?: DigestStateValueConfidence[];
    volatileContext?: DigestStateValueConfidence[];
    openQuestions?: DigestStateValueConfidence[];
    risks?: DigestStateValueConfidence[];
  };
  provenance?: {
    goal?: DigestEvidenceRef[];
    constraints?: DigestStateValueProvenance[];
    decisions?: DigestStateValueProvenance[];
    todos?: DigestStateValueProvenance[];
    volatileContext?: DigestStateValueProvenance[];
    openQuestions?: DigestStateValueProvenance[];
    risks?: DigestStateValueProvenance[];
  };
  transitionSummary?: Record<string, number>;
  recentChanges?: DigestStateChange[];
  factRegistry?: FactRegistryEntry[];
}
```
With:
```typescript
export interface DigestState {
  stableFacts: {
    goal?: string;
    constraints?: string[];
    decisions: string[];
  };
  workingNotes: {
    openQuestions?: string[];
    risks?: string[];
    context?: string;
  };
  todos: string[];
  volatileContext?: string[];
  evidenceRefs?: DigestEvidenceRef[];
  confidence?: {
    goal?: number;
    constraints?: DigestStateValueConfidence[];
    decisions?: DigestStateValueConfidence[];
    todos?: DigestStateValueConfidence[];
    volatileContext?: DigestStateValueConfidence[];
    openQuestions?: DigestStateValueConfidence[];
    risks?: DigestStateValueConfidence[];
  };
  provenance?: {
    goal?: DigestEvidenceRef[];
    constraints?: DigestStateValueProvenance[];
    decisions?: DigestStateValueProvenance[];
    todos?: DigestStateValueProvenance[];
    volatileContext?: DigestStateValueProvenance[];
    openQuestions?: DigestStateValueProvenance[];
    risks?: DigestStateValueProvenance[];
  };
  transitionSummary?: Record<string, number>;
  recentChanges?: DigestStateChange[];
  factRegistry?: FactRegistryEntry[];
  profile?: {
    identity?: string[];
    relationships?: string[];
    ongoing?: string[];
    goals?: string[];
    followUps?: string[];
  };
}
```

**b) `packages/core/src/digest-control.ts` — extend `FactRegistryEntry` (lines 51–60):**

Replace:
```typescript
export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
}
```
With:
```typescript
export interface FactRegistryEntry {
  id: string;
  content: string;
  type: "decision" | "constraint" | "profile";
  confidence: number;
  addedAt: string;
  evidenceId: string;
  evidenceType: "event" | "document";
  supersededBy?: string;
  facet?: string;
}
```

**c) `packages/core/src/digest-control.ts` — preserve `profile` in `normalizeDigestState` (lines 280–283):**

The return statement in `normalizeDigestState` ends at line 280–283. After the `factRegistry` line, add `profile` preservation:

Replace:
```typescript
    factRegistry: ((base as DigestState).factRegistry ?? [])
      .filter((entry) => !entry.supersededBy)
      .slice(-100)
  };
}
```
With:
```typescript
    factRegistry: ((base as DigestState).factRegistry ?? [])
      .filter((entry) => !entry.supersededBy)
      .slice(-100),
    profile: (base as DigestState).profile
      ? {
          identity: ((base as DigestState).profile!.identity ?? []).slice(0, 15),
          relationships: ((base as DigestState).profile!.relationships ?? []).slice(0, 10),
          ongoing: ((base as DigestState).profile!.ongoing ?? []).slice(0, 8),
          goals: ((base as DigestState).profile!.goals ?? []).slice(0, 8),
          followUps: ((base as DigestState).profile!.followUps ?? []).slice(0, 10)
        }
      : undefined
  };
}
```

**d) `packages/contracts/src/index.ts` — extend `StateLayerView` Zod schema (lines 274–281):**

Replace:
```typescript
export const StateLayerView = z.object({
  goal: z.string().optional(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  todos: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string())
});
```
With:
```typescript
export const StateLayerView = z.object({
  goal: z.string().optional(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  todos: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  identity: z.array(z.string()).optional(),
  relationships: z.array(z.string()).optional(),
  ongoing: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional()
});
```

**e) `packages/contracts/src/index.ts` — extend `DigestState` Zod schema (line 490, before closing `}`):**

The Zod `DigestState` schema closes at line 490 (`});`). Insert `profile` before the closing:

Replace:
```typescript
  transitionSummary: z.record(z.string(), z.number()).optional(),
  recentChanges: z.array(z.object({
    field: z.enum(["goal", "constraints", "decisions", "todos", "volatileContext", "openQuestions", "risks"]),
    action: z.enum(["set", "add", "remove", "reaffirm"]),
    value: z.string(),
    evidence: z.object({
      id: z.string(),
      sourceType: z.enum(["document", "event"]),
      key: z.string().optional(),
      kind: MemoryEventKind.optional()
    })
  })).optional()
});
```
With:
```typescript
  transitionSummary: z.record(z.string(), z.number()).optional(),
  recentChanges: z.array(z.object({
    field: z.enum(["goal", "constraints", "decisions", "todos", "volatileContext", "openQuestions", "risks"]),
    action: z.enum(["set", "add", "remove", "reaffirm"]),
    value: z.string(),
    evidence: z.object({
      id: z.string(),
      sourceType: z.enum(["document", "event"]),
      key: z.string().optional(),
      kind: MemoryEventKind.optional()
    })
  })).optional(),
  profile: z.object({
    identity: z.array(z.string()).optional(),
    relationships: z.array(z.string()).optional(),
    ongoing: z.array(z.string()).optional(),
    goals: z.array(z.string()).optional(),
    followUps: z.array(z.string()).optional()
  }).optional()
});
```

- [ ] **2.4 Confirm tests pass**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "digest-state-profile"
```

Expected: 3/3 green. Then run full suite:

```bash
pnpm --filter @statecore/core test
```

Expected: all existing tests including `digest-state-serialization` still pass (the `factRegistry` round-trip test must still work because `FactRegistryEntry.type` union is additive).

- [ ] **2.5 Commit**:

```bash
git add packages/core/src/digest-control.ts packages/contracts/src/index.ts packages/core/src/digest-state-profile.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): add profile field to DigestState, FactRegistryEntry, and Zod contracts

Extends DigestState TS interface with optional profile facets (identity,
relationships, ongoing, goals, followUps). Adds facet?: string and
type="profile" to FactRegistryEntry. normalizeDigestState now preserves
profile through JSON round-trips (capped at per-facet limits). Zod
contracts in StateLayerView and DigestState extended to match. All
additive/optional; existing serialization tests remain green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Stream Routing (`classifiedType` → `profile.identity`)

### Files

| Role | Path | Lines touched |
|---|---|---|
| Modify | `packages/core/src/index.ts` | 79–90 (`MemoryEvent`) |
| Modify | `packages/core/src/digest-control.ts` | 898–915 (`promoteToFactRegistry`), after-1319 (add `mergeProfileFacets`), 1130–1135 (call site in `protectedStateMerge`) |
| Test | `packages/core/src/digest-control.test.ts` | add `describe` block |

### Interfaces

**Consumes:** `DeltaCandidate.event.classifiedType?: string | null`
**Produces:** `DigestState.profile.identity[]` (write-protected via `factRegistry[facet="identity"]`)

### Steps

- [ ] **3.1 Write failing tests** — append to `packages/core/src/digest-control.test.ts`:

```typescript
describe("mergeProfileFacets — stream routing via protectedStateMerge", () => {
  function makeStreamEvent(
    id: string,
    content: string,
    classifiedType: string | null = null
  ): MemoryEvent {
    return event({ id, scopeId: "sc", userId: "u", type: "stream", content, classifiedType });
  }

  it("personal_detail event routes to profile.identity", () => {
    const state = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        {
          eventId: "e1",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.5, noveltyScore: 0.8 },
          event: makeStreamEvent("e1", "工作经历: 字节跳动 后端工程师 2019-2022", "personal_detail")
        }
      ],
      documents: []
    });
    expect(state.profile?.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
  });

  it("write-protected identity fact survives a contradicting stream event with Jaccard >= 0.6", () => {
    // First merge: add a personal_detail fact (it becomes write-protected)
    const state1 = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        {
          eventId: "e1",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.5, noveltyScore: 0.8 },
          event: makeStreamEvent("e1", "工作经历: 字节跳动 后端工程师 2019-2022", "personal_detail")
        }
      ],
      documents: []
    });
    expect(state1.profile?.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
    expect((state1.factRegistry ?? []).some((e) => e.facet === "identity")).toBe(true);

    // Second merge: contradicting stream event with high Jaccard overlap
    const state2 = protectedStateMerge({
      prevState: state1,
      deltaCandidates: [
        {
          eventId: "e2",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.5, noveltyScore: 0.8 },
          event: makeStreamEvent("e2", "工作经历: 字节跳动 前端工程师 2019-2022", "personal_detail")
        }
      ],
      documents: []
    });
    // The write-protected original must survive; the contradiction must not overwrite
    expect(state2.profile?.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
  });

  it("feeling and emotional_pattern events do NOT route to any profile facet", () => {
    const state = protectedStateMerge({
      prevState: null,
      deltaCandidates: [
        {
          eventId: "e1",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.4, noveltyScore: 0.8 },
          event: makeStreamEvent("e1", "今天很累", "feeling")
        },
        {
          eventId: "e2",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.4, noveltyScore: 0.8 },
          event: makeStreamEvent("e2", "每周都觉得焦虑", "emotional_pattern")
        }
      ],
      documents: []
    });
    expect(state.profile?.identity ?? []).toHaveLength(0);
  });
});
```

Note: The `event` helper at the top of `digest-control.test.ts` (line 17) does not accept `classifiedType`. You must extend it to pass optional extra properties through to the `MemoryEvent` shape. Update the helper signature:

Replace (line 17–23 of `digest-control.test.ts`):
```typescript
function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "scopeId" | "userId" | "content" | "type">): MemoryEvent {
  return {
    source: "api",
    createdAt: new Date(),
    ...partial
  };
}
```
With (identical — no change needed once `MemoryEvent` gets `classifiedType?` in step 3.3a; TypeScript will accept it through the spread):
```typescript
function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "scopeId" | "userId" | "content" | "type">): MemoryEvent {
  return {
    source: "api",
    createdAt: new Date(),
    ...partial
  };
}
```

- [ ] **3.2 Confirm tests fail**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "mergeProfileFacets"
```

Expected: TypeScript compile error on `classifiedType` (not on `MemoryEvent`); runtime failures for routing assertions.

- [ ] **3.3 Implement**:

**a) `packages/core/src/index.ts` — add `classifiedType` to `MemoryEvent` (after line 89):**

Replace:
```typescript
export interface MemoryEvent {
  id: string;
  userId: string;
  scopeId: string;
  type: MemoryType;
  source: MemorySource;
  key?: string | null;
  content: string;
  contentHash?: string | null;
  createdAt: Date;
  updatedAt?: Date | null;
}
```
With:
```typescript
export interface MemoryEvent {
  id: string;
  userId: string;
  scopeId: string;
  type: MemoryType;
  source: MemorySource;
  key?: string | null;
  content: string;
  contentHash?: string | null;
  createdAt: Date;
  updatedAt?: Date | null;
  classifiedType?: string | null;
}
```

**b) `packages/core/src/digest-control.ts` — extend `promoteToFactRegistry` to accept optional `facet` (lines 898–915):**

Replace:
```typescript
function promoteToFactRegistry(
  state: DigestState,
  content: string,
  type: FactRegistryEntry["type"],
  confidence: number,
  evidence: DigestEvidenceRef
): void {
  if (!state.factRegistry) state.factRegistry = [];
  if (isInFactRegistry(state, content)) return;
  state.factRegistry.push({
    id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    content,
    type,
    confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  });
}
```
With:
```typescript
function promoteToFactRegistry(
  state: DigestState,
  content: string,
  type: FactRegistryEntry["type"],
  confidence: number,
  evidence: DigestEvidenceRef,
  facet?: string
): void {
  if (!state.factRegistry) state.factRegistry = [];
  if (isInFactRegistry(state, content)) return;
  const entry: FactRegistryEntry = {
    id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    content,
    type,
    confidence,
    addedAt: new Date().toISOString(),
    evidenceId: evidence.id,
    evidenceType: evidence.sourceType
  };
  if (facet !== undefined) entry.facet = facet;
  state.factRegistry.push(entry);
}
```

**c) `packages/core/src/digest-control.ts` — add `mergeProfileFacets` function** (insert immediately before the closing `}` of `protectedStateMerge`, i.e., before line 1334; actually add it as a separate function BEFORE `protectedStateMerge` or anywhere internal — best after `promoteToFactRegistry` at ~line 916):

Add the following new function after `supersedeFact` (around line 936):
```typescript
function mergeProfileFacets(
  state: DigestState,
  events: MemoryEvent[],
  prevFactRegistryIds: Set<string>
): void {
  if (!state.profile) state.profile = {};
  if (!state.profile.identity) state.profile.identity = [];

  const IDENTITY_CAP = 15;

  function isIdentityProtected(fact: string): boolean {
    return (state.factRegistry ?? []).some(
      (e) =>
        prevFactRegistryIds.has(e.id) &&
        !e.supersededBy &&
        e.facet === "identity" &&
        jaccardSimilarity(normalizeText(e.content), normalizeText(fact)) >= 0.6
    );
  }

  for (const evt of events) {
    if (evt.classifiedType !== "personal_detail") continue;
    const incomingValue = evt.content.trim();
    if (!incomingValue) continue;

    const identityFacts = state.profile.identity!;

    // Dedup: Jaccard >= 0.6 within facet
    const existingIdx = identityFacts.findIndex(
      (fact) => jaccardSimilarity(fact, incomingValue) >= 0.6
    );

    if (existingIdx !== -1) {
      const existing = identityFacts[existingIdx];
      if (isIdentityProtected(existing)) continue; // write-protected — stream cannot override
      identityFacts[existingIdx] = incomingValue; // replace unprotected near-duplicate
      continue;
    }

    // Cap enforcement: if at limit, evict the first unprotected entry
    if (identityFacts.length >= IDENTITY_CAP) {
      const unprotectedIdx = identityFacts.findIndex((fact) => !isIdentityProtected(fact));
      if (unprotectedIdx === -1) continue; // all protected, cannot evict — discard incoming
      identityFacts.splice(unprotectedIdx, 1);
    }

    identityFacts.push(incomingValue);

    // Write-protect this new identity fact via factRegistry
    const evidence: DigestEvidenceRef = { id: evt.id, sourceType: "event" };
    promoteToFactRegistry(state, incomingValue, "profile", 0.7, evidence, "identity");
  }
}
```

**d) `packages/core/src/digest-control.ts` — call `mergeProfileFacets` from `protectedStateMerge`** — insert after the `orderedDeltas` loop (around line 1319, just before the `next.stableFacts.decisions = [...new Set...` dedup block):

In `protectedStateMerge`, after the closing `}` of the `for (const delta of orderedDeltas)` loop and before the final dedup lines, add:

```typescript
  // Profile facet routing: personal_detail stream events → profile.identity (Stage 1)
  const streamEventsForProfile = input.deltaCandidates.map((d) => d.event);
  mergeProfileFacets(next, streamEventsForProfile, prevFactRegistryIds);
```

- [ ] **3.4 Confirm tests pass**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "mergeProfileFacets"
```

Expected: 3/3 green. Run full suite:

```bash
pnpm --filter @statecore/core test
```

Expected: all existing tests pass (existing call sites of `promoteToFactRegistry` omit the new optional `facet` parameter — TypeScript allows this).

- [ ] **3.5 Commit**:

```bash
git add packages/core/src/index.ts packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): route personal_detail stream events to profile.identity

Adds classifiedType?: string | null to MemoryEvent. Adds mergeProfileFacets()
which routes events with classifiedType==="personal_detail" into
DigestState.profile.identity using the digest-control Jaccard tokeniser
(threshold 0.6, cap 15). Write-protects all identity entries via factRegistry
with facet="identity"; protected facts survive contradicting stream events.
Called from protectedStateMerge after the delta loop.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Document→Identity LLM Extraction

### Files

| Role | Path | Lines touched |
|---|---|---|
| Modify | `packages/core/src/digest-control.ts` | 115–131 (`DigestOutput` + `DigestOutputSchema`), 1755–1759 (`normalized` in `generateDigestStage2`), 1562–1567 (`alignDigestWithState`), add `applyProfileFactsFromDigest`, 1887–1901 (`runDigestControlPipeline` — apply after generate) |
| Modify | `packages/prompts/src/index.ts` | `digestStage2SystemPrompt`, `digestStage2UserPrompt` |
| Test | `packages/core/src/digest-control.test.ts` | add `describe` block |

### Interfaces

**Consumes:** `DigestOutput.profileFacts?: { facet: string; value: string }[]` from LLM; `MemoryEvent[]` documents as evidence source
**Produces:** `DigestState.profile.identity[]` (document authority 0.85, write-protected)

### Steps

- [ ] **4.1 Write failing test** — append to `packages/core/src/digest-control.test.ts`:

```typescript
describe("doc→identity: applyProfileFactsFromDigest via generateDigestStage2", () => {
  it("mock LLM returning profileFacts routes facet=identity into state.profile.identity", async () => {
    const mockLlm = {
      chat: async (_messages: { role: "system" | "user"; content: string }[]) => {
        return JSON.stringify({
          summary: "Processed resume with work history.",
          changes: ["Resume ingested for 字节跳动."],
          nextSteps: ["Review extracted identity facts."],
          profileFacts: [
            { facet: "identity", value: "工作经历: 字节跳动 后端工程师 2019-2022" },
            { facet: "identity", value: "教育: 北京大学 计算机科学 2015-2019" }
          ]
        });
      }
    };

    const resumeDoc = event({
      id: "doc-resume",
      scopeId: "sc",
      userId: "u",
      type: "document",
      key: "resume:main",
      content: "工作经历: 字节跳动 后端工程师 2019-2022\n教育: 北京大学 计算机科学 2015-2019",
      createdAt: new Date("2026-06-20T10:00:00Z")
    });

    const baseState: DigestState = {
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: []
    };

    const scope = {
      id: "sc",
      userId: "u",
      name: "personal",
      goal: null,
      stage: "active" as const,
      createdAt: new Date()
    };

    const digest = await generateDigestStage2({
      scope,
      protectedState: baseState,
      deltaCandidates: [],
      documents: [resumeDoc],
      llm: mockLlm,
      systemPrompt: "Output JSON only.",
      userPromptTemplate: "{{protectedState}} {{documents}}",
      maxRetries: 0
    });

    // profileFacts must survive alignment
    expect(digest.profileFacts).toBeDefined();
    expect(digest.profileFacts?.some((pf) => pf.value.includes("字节跳动"))).toBe(true);
  });
});
```

- [ ] **4.2 Confirm test fails**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "doc.identity"
```

Expected: TypeScript error on `profileFacts` (not on `DigestOutput`); assertion failure.

- [ ] **4.3 Implement**:

**a) `packages/core/src/digest-control.ts` — extend `DigestOutput` interface (lines 115–119):**

Replace:
```typescript
export interface DigestOutput {
  summary: string;
  changes: string[];
  nextSteps: string[];
}
```
With:
```typescript
export interface DigestOutput {
  summary: string;
  changes: string[];
  nextSteps: string[];
  profileFacts?: { facet: string; value: string }[];
}
```

**b) `packages/core/src/digest-control.ts` — extend `DigestOutputSchema` Zod (lines 127–131):**

Replace:
```typescript
export const DigestOutputSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string())
});
```
With:
```typescript
export const DigestOutputSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string()),
  profileFacts: z.array(z.object({
    facet: z.string(),
    value: z.string()
  })).optional()
});
```

**c) `packages/core/src/digest-control.ts` — preserve `profileFacts` in `normalized` inside `generateDigestStage2` (lines 1755–1759):**

Replace:
```typescript
    const normalized: DigestOutput = {
      summary: validated.data.summary.trim(),
      changes: validated.data.changes.map((c) => c.trim()).filter(Boolean).slice(0, 3),
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean).slice(0, 3)
    };
```
With:
```typescript
    const normalized: DigestOutput = {
      summary: validated.data.summary.trim(),
      changes: validated.data.changes.map((c) => c.trim()).filter(Boolean).slice(0, 3),
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean).slice(0, 3),
      profileFacts: (validated.data.profileFacts ?? [])
        .map((pf) => ({ facet: pf.facet.trim(), value: pf.value.trim() }))
        .filter((pf) => Boolean(pf.facet) && Boolean(pf.value))
    };
```

**d) `packages/core/src/digest-control.ts` — preserve `profileFacts` through `alignDigestWithState` (lines 1562–1567):**

Replace:
```typescript
function alignDigestWithState(output: DigestOutput, state: DigestState): DigestOutput {
  return {
    summary: buildProjectedSummary(state, output.summary),
    changes: selectAlignedChanges(output, state),
    nextSteps: selectAlignedNextSteps(output, state)
  };
}
```
With:
```typescript
function alignDigestWithState(output: DigestOutput, state: DigestState): DigestOutput {
  return {
    summary: buildProjectedSummary(state, output.summary),
    changes: selectAlignedChanges(output, state),
    nextSteps: selectAlignedNextSteps(output, state),
    profileFacts: output.profileFacts
  };
}
```

**e) `packages/core/src/digest-control.ts` — add `applyProfileFactsFromDigest` function** (add after `mergeProfileFacets` function, around line 970):

```typescript
function applyProfileFactsFromDigest(
  state: DigestState,
  profileFacts: { facet: string; value: string }[],
  documents: MemoryEvent[]
): void {
  if (!state.profile) state.profile = {};
  const IDENTITY_CAP = 15;

  // Use the last document as evidence (document authority 0.85)
  const latestDoc = documents.length > 0 ? documents[documents.length - 1] : null;
  const docEvidence: DigestEvidenceRef | null = latestDoc
    ? { id: latestDoc.id, sourceType: "document", key: latestDoc.key ?? undefined }
    : null;

  for (const pf of profileFacts) {
    if (pf.facet !== "identity") continue; // Stage 1: only identity
    const value = pf.value.trim();
    if (!value) continue;

    if (!state.profile.identity) state.profile.identity = [];
    const identityFacts = state.profile.identity;

    // Dedup: Jaccard >= 0.6 → document supersedes existing (document > stream authority)
    const existingIdx = identityFacts.findIndex(
      (fact) => jaccardSimilarity(fact, value) >= 0.6
    );

    if (existingIdx !== -1) {
      const existing = identityFacts[existingIdx];
      // Document supersedes existing (even write-protected stream entries)
      if (docEvidence) {
        supersedeFact(state, existing, value, docEvidence);
      }
      identityFacts[existingIdx] = value;
      continue;
    }

    // Cap: document facts are high-value; if at cap, don't add (avoid evicting protected entries)
    if (identityFacts.length >= IDENTITY_CAP) continue;

    identityFacts.push(value);
    if (docEvidence) {
      promoteToFactRegistry(state, value, "profile", 0.85, docEvidence, "identity");
    }
  }
}
```

**f) `packages/core/src/digest-control.ts` — call `applyProfileFactsFromDigest` in `runDigestControlPipeline`** (after `generateDigestStage2` returns, around line 1901):

Find:
```typescript
  metrics.generationMs = Date.now() - tGenerate;

  const resolvedGoal = input.scope.goal?.trim() || undefined;
```
Replace with:
```typescript
  metrics.generationMs = Date.now() - tGenerate;

  // Apply profile facts extracted by LLM from documents into stable state
  if (digest.profileFacts && digest.profileFacts.length > 0) {
    applyProfileFactsFromDigest(state, digest.profileFacts, selection.documents);
  }

  const resolvedGoal = input.scope.goal?.trim() || undefined;
```

**g) `packages/prompts/src/index.ts` — update `digestStage2SystemPrompt` to instruct LLM to extract `profileFacts`:**

Replace:
```typescript
export const digestStage2SystemPrompt = `You are a long-term memory engine. Create a concise and faithful digest.
Rules:
- Output JSON only.
- goal must be a single short line (the scope goal, verbatim or lightly refined).
- summary must be <= 120 words.
- changes must be <= 3 bullets.
- nextSteps must be 1-3 concrete actionable tasks.
- Do not invent facts not present in the provided evidence.`;
```
With:
```typescript
export const digestStage2SystemPrompt = `You are a long-term memory engine. Create a concise and faithful digest.
Rules:
- Output JSON only.
- goal must be a single short line (the scope goal, verbatim or lightly refined).
- summary must be <= 120 words.
- changes must be <= 3 bullets.
- nextSteps must be 1-3 concrete actionable tasks.
- profileFacts: array of {facet, value} pairs. Extract ONLY from document bodies (resumes, profiles, bios). Use facet "identity" for durable personal facts: 工作经历, 教育, 技能, 联系方式 lines. Each value must be a self-contained fact line (e.g. "工作经历: 字节跳动 后端工程师 2019-2022"). Omit profileFacts entirely if no documents contain personal profile data. Do not invent.
- Do not invent facts not present in the provided evidence.`;
```

**h) `packages/prompts/src/index.ts` — update `digestStage2UserPrompt` return JSON spec:**

Replace:
```typescript
Return JSON: {"goal": string, "summary": string, "changes": string[], "nextSteps": string[]}
goal: one-line restatement of the scope goal (use the Goal field above verbatim if unchanged).`;
```
With:
```typescript
Return JSON: {"goal": string, "summary": string, "changes": string[], "nextSteps": string[], "profileFacts": [{"facet": string, "value": string}]}
goal: one-line restatement of the scope goal (use the Goal field above verbatim if unchanged).
profileFacts: only include when Latest documents contain personal identity data (resume, bio). Use facet "identity".`;
```

- [ ] **4.4 Confirm tests pass**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "doc.identity"
```

Expected: 1/1 green. Run full suite:

```bash
pnpm --filter @statecore/core test
```

Expected: all existing tests pass. Pay attention to `digest-control.test.ts` — `generateDigestStage2` tests that use mock LLMs returning `{"summary":...,"changes":...,"nextSteps":...}` (without `profileFacts`) must still pass because `profileFacts` is optional in the Zod schema.

- [ ] **4.5 Commit**:

```bash
git add packages/core/src/digest-control.ts packages/prompts/src/index.ts packages/core/src/digest-control.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): extend DigestOutput with profileFacts for doc→identity extraction

Adds profileFacts?: {facet, value}[] to DigestOutput and DigestOutputSchema.
generateDigestStage2 normalises and preserves profileFacts through
alignDigestWithState. New applyProfileFactsFromDigest() routes facet="identity"
entries into DigestState.profile.identity at document authority 0.85 with
write-protection. runDigestControlPipeline calls it after LLM generation.
digestStage2SystemPrompt updated to instruct LLM to extract identity facts
from resume/profile documents.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Consistency Check for Profile Identity

### Files

| Role | Path | Lines touched |
|---|---|---|
| Modify | `packages/core/src/digest-control.ts` | 1664–1697 (`consistencyCheck` body — after existing todo contradiction block) |
| Test | `packages/core/src/digest-control.test.ts` | add `describe` block |

### Interfaces

**Consumes:** `DigestState.factRegistry[]` with `facet === "identity"` and `!supersededBy`; `DigestOutput.summary + changes + nextSteps`
**Produces:** `DigestConsistencyResult.errors` containing `"profile_identity_contradiction"` when LLM negates a protected identity fact

### Steps

- [ ] **5.1 Write failing tests** — append to `packages/core/src/digest-control.test.ts`:

```typescript
describe("consistencyCheck — profile_identity_contradiction", () => {
  const protectedState: DigestState = {
    stableFacts: { decisions: [] },
    workingNotes: {},
    todos: [],
    factRegistry: [
      {
        id: "fact-identity-1",
        content: "工作经历: 字节跳动 后端工程师 2019-2022",
        type: "profile",
        facet: "identity",
        confidence: 0.85,
        addedAt: "2026-06-20T00:00:00.000Z",
        evidenceId: "doc-resume",
        evidenceType: "document"
      }
    ],
    profile: {
      identity: ["工作经历: 字节跳动 后端工程师 2019-2022"]
    }
  };

  it("emits profile_identity_contradiction when summary negates a protected identity fact", () => {
    const result = consistencyCheck({
      output: {
        summary: "The user no longer worked at 字节跳动 engineering.",
        changes: ["工作经历 at 字节跳动 was incorrect."],
        nextSteps: ["Update the resume."]
      },
      protectedState
    });
    expect(result.errors).toContain("profile_identity_contradiction");
  });

  it("does NOT emit profile_identity_contradiction when identity fact is mentioned without negation", () => {
    const result = consistencyCheck({
      output: {
        summary: "Processed resume showing 字节跳动 backend role 2019-2022.",
        changes: ["Ingested work history entry for 字节跳动."],
        nextSteps: ["Review extracted profile for accuracy."]
      },
      protectedState
    });
    expect(result.errors).not.toContain("profile_identity_contradiction");
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **5.2 Confirm tests fail**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "profile_identity_contradiction"
```

Expected: 2 failures — `consistencyCheck` does not yet check profile.

- [ ] **5.3 Implement** — `packages/core/src/digest-control.ts`, inside `consistencyCheck`, after the existing `todoNegation` block (around line 1672), before the `previousDigest` repeats check:

The existing todo block ends at line ~1672:
```typescript
  for (const todo of stableTodos) {
    if (mentionsFactWithNegation(combinedText, normalizeTodoFactText(todo), todoNegation)) {
      errors.push("todo_contradiction");
      break;
    }
  }
```

Insert after that block:
```typescript
  // Profile identity: check write-protected identity facts in factRegistry
  const identityNegation = /\b(not|no longer|incorrect|wrong|remove|delete|revoke|cancel|never)\b/;
  const protectedIdentityFacts = (input.protectedState.factRegistry ?? [])
    .filter((e) => !e.supersededBy && e.facet === "identity")
    .map((e) => e.content);
  for (const fact of protectedIdentityFacts) {
    if (mentionsFactWithNegation(combinedText, fact, identityNegation)) {
      errors.push("profile_identity_contradiction");
      break;
    }
  }
```

- [ ] **5.4 Confirm tests pass**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "profile_identity_contradiction"
```

Expected: 2/2 green. Run full suite:

```bash
pnpm --filter @statecore/core test
```

Expected: all existing tests pass. The existing `consistencyCheck` tests do not have `factRegistry` entries with `facet="identity"`, so they are unaffected.

- [ ] **5.5 Commit**:

```bash
git add packages/core/src/digest-control.ts packages/core/src/digest-control.test.ts
git commit -m "$(cat <<'EOF'
feat(profile): extend consistencyCheck with profile_identity_contradiction

When the LLM digest output contains negation language that matches a
write-protected identity fact (factRegistry entry with facet="identity"),
consistencyCheck now emits "profile_identity_contradiction". Mirrors the
existing decision_contradiction and constraint_contradiction checks.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — E2E Integration Test (Probe B2 Re-run)

### Files

| Role | Path | Lines touched |
|---|---|---|
| Test | `packages/core/src/digest-control.test.ts` | add `describe` block at end |
| Manual | benchmark script | `node scripts/benchmark/run-benchmark.mjs` (requires live API) |

### Interfaces

**Consumes:** full pipeline — `runDigestControlPipeline` with resume document + mock LLM returning `profileFacts`
**Produces:**
- `result.state.profile.identity` contains `"工作经历: 字节跳动 后端工程师 2019-2022"` ✅
- `formatStateLayerView(compileStateLayerView(result.state))` contains `"你是谁/档案:"` ✅
- project-template scope: `result.state.profile` is undefined, no profile sections ✅
- benchmark: `consistencyPassRate` and `goldRetention` not lower than pre-Stage-1 baseline

### Steps

- [ ] **6.1 Write E2E test** — append to `packages/core/src/digest-control.test.ts`:

```typescript
import { compileStateLayerView, formatStateLayerView } from "./working-memory.compiler";

describe("E2E Probe B2 — resume document → profile.identity → State block", () => {
  const mockPersonalLlm = {
    chat: async (_messages: { role: "system" | "user"; content: string }[]) => {
      return JSON.stringify({
        summary: "Processed personal resume document.",
        changes: ["Work history at 字节跳动 ingested from resume."],
        nextSteps: ["Review extracted identity facts for accuracy."],
        profileFacts: [
          { facet: "identity", value: "工作经历: 字节跳动 后端工程师 2019-2022" },
          { facet: "identity", value: "教育: 北京大学 计算机科学 2015-2019" },
          { facet: "identity", value: "技能: Go, Python, 分布式系统" }
        ]
      });
    }
  };

  const mockProjectLlm = {
    chat: async (_messages: { role: "system" | "user"; content: string }[]) => {
      return JSON.stringify({
        summary: "Architecture review session completed.",
        changes: ["Decision to use Postgres finalized."],
        nextSteps: ["Document the database schema design."]
        // no profileFacts
      });
    }
  };

  const baseConfig = {
    eventBudgetTotal: 10,
    eventBudgetDocs: 5,
    eventBudgetStream: 5,
    noveltyThreshold: 0.4,
    maxRetries: 0,
    useLlmClassifier: false,
    debug: false
  };

  const basePrompts = {
    digestStage2SystemPrompt: "Output JSON only.",
    digestStage2UserPrompt: "{{protectedState}} {{documents}}"
  };

  it("字节跳动 lands in state.profile.identity after resume digest", async () => {
    const resumeDoc = event({
      id: "doc-resume",
      scopeId: "sc-personal",
      userId: "u1",
      type: "document",
      key: "resume:main",
      content: "工作经历: 字节跳动 后端工程师 2019-2022\n教育: 北京大学 计算机科学 2015-2019",
      createdAt: new Date("2026-06-20T10:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: {
        id: "sc-personal",
        userId: "u1",
        name: "personal",
        goal: null,
        stage: "active",
        createdAt: new Date()
      },
      recentEvents: [resumeDoc],
      llm: mockPersonalLlm,
      prompts: basePrompts,
      config: baseConfig
    });

    expect(result.state.profile?.identity).toBeDefined();
    expect(result.state.profile!.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");

    // Probe B2 north-star: 字节跳动 appears in the rendered State block
    const view = compileStateLayerView(result.state);
    const rendered = formatStateLayerView(view);
    expect(rendered).toContain("你是谁/档案:");
    expect(rendered).toContain("字节跳动");
  });

  it("project-template non-regression: no profile sections, 6 PM slots intact", async () => {
    const projectEvent = event({
      id: "e-decision",
      scopeId: "sc-project",
      userId: "u1",
      type: "stream",
      content: "We decide to use Postgres for the main database",
      createdAt: new Date("2026-06-20T10:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: {
        id: "sc-project",
        userId: "u1",
        name: "DEMS",
        goal: "ship stable API",
        stage: "build",
        createdAt: new Date()
      },
      recentEvents: [projectEvent],
      llm: mockProjectLlm,
      prompts: basePrompts,
      config: baseConfig
    });

    expect(result.state.profile).toBeUndefined();

    const view = compileStateLayerView(result.state);
    const rendered = formatStateLayerView(view);
    expect(rendered).not.toContain("你是谁");
    expect(rendered).not.toContain("人际");
    expect(rendered).not.toContain("正在经历");
    expect(rendered).toContain("Stable goal: ship stable API");
  });

  it("identity facts are write-protected: factRegistry has facet=identity entry after resume digest", async () => {
    const resumeDoc = event({
      id: "doc-resume-2",
      scopeId: "sc-personal-2",
      userId: "u1",
      type: "document",
      key: "resume:secondary",
      content: "工作经历: 字节跳动 后端工程师 2019-2022",
      createdAt: new Date("2026-06-20T11:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: {
        id: "sc-personal-2",
        userId: "u1",
        name: "personal",
        goal: null,
        stage: "active",
        createdAt: new Date()
      },
      recentEvents: [resumeDoc],
      llm: mockPersonalLlm,
      prompts: basePrompts,
      config: baseConfig
    });

    const identityEntries = (result.state.factRegistry ?? []).filter(
      (e) => !e.supersededBy && e.facet === "identity"
    );
    expect(identityEntries.length).toBeGreaterThan(0);
    expect(identityEntries.some((e) => e.confidence >= 0.85)).toBe(true);
  });
});
```

- [ ] **6.2 Confirm E2E test fails** (all Task 1–5 commits already in):

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test -- "Probe B2"
```

Expected: This test should already pass after Tasks 1–5 are complete. If it fails, identify which assertion fails and trace back to the relevant task.

- [ ] **6.3 Run full test suite**:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @statecore/core test
```

Expected: all 27+ test files green.

- [ ] **6.4 Benchmark non-regression** (requires live API at `http://localhost:3002`):

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
node scripts/benchmark/run-benchmark.mjs
```

Check output for:
- `consistencyPassRate` ≥ pre-Stage-1 baseline (from `benchmark-results/` latest `.json`)
- `goldRetention.stateFactRetentionRate` ≥ baseline
- `goldRetention.stateDecisionContinuityRate` ≥ baseline

If any metric regresses, check whether the prompt changes in Task 4 (`profileFacts` instruction) interfere with PM-scope benchmark scenarios. If so, the mitigation is to make the `profileFacts` instruction conditional on whether `Latest documents` contains obvious personal data.

- [ ] **6.5 Commit**:

```bash
git add packages/core/src/digest-control.test.ts
git commit -m "$(cat <<'EOF'
test(profile): E2E integration test for Probe B2 (resume → State block)

Adds three E2E scenarios to digest-control.test.ts:
1. Resume document → profile.identity → 字节跳动 rendered under 你是谁/档案: (Probe B2 north-star)
2. Project-template non-regression: no profile sections, 6 PM slots intact
3. Write-protection: factRegistry contains facet=identity entries at 0.85 confidence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review — Stage 1 Spec Requirements Mapping

| Spec requirement (§ reference) | Implemented in |
|---|---|
| `DigestState.profile` with 5 optional facets (`identity`, `relationships`, `ongoing`, `goals`, `followUps`), each `string[]` (§4) | Task 2 (TS interface + `normalizeDigestState`) |
| Per-facet cap: identity=15 (§4) | Task 3 (`mergeProfileFacets` IDENTITY_CAP) + Task 4 (`applyProfileFactsFromDigest` IDENTITY_CAP) |
| Zod contract: `DigestState` and `StateLayerView` accept `profile?` (§4) | Task 2 (contracts Zod schemas) |
| `FactRegistryEntry.facet?: string` and `type: "profile"` (§5c) | Task 2 (`FactRegistryEntry` interface) |
| `classifiedType` consumed by digest pipeline (§1, §5a) | Task 3 (`MemoryEvent.classifiedType?` + `mergeProfileFacets`) |
| `personal_detail` → `profile.identity` routing (§4 mapping table) | Task 3 (`mergeProfileFacets`) |
| Jaccard dedup within facet, threshold 0.6 (§5b) | Task 3 (`mergeProfileFacets` using `jaccardSimilarity` from `digest-control.ts:356`) |
| Write-protection for identity via `factRegistry[facet="identity"]` (§5c) | Task 3 (`promoteToFactRegistry` with `facet="identity"`) |
| Write-protected facts survive contradicting stream events (§5c) | Task 3 (protected-check in `mergeProfileFacets` + test) |
| `DigestOutput.profileFacts` LLM schema extension (§5d) | Task 4 (`DigestOutput` + `DigestOutputSchema`) |
| Document → identity LLM extraction with authority 0.85 (§5d) | Task 4 (`applyProfileFactsFromDigest`, confidence=0.85) |
| `profileFacts` preserved through `alignDigestWithState` (§5d) | Task 4 (`alignDigestWithState`) |
| Digest prompt instructs LLM to extract identity facts from docs (§5d) | Task 4 (`digestStage2SystemPrompt` + `digestStage2UserPrompt`) |
| `StateLayerView` profile fields rendered via `formatStateLayerView` (§6) | Task 1 (`formatStateLayerView` + `pushSection`) |
| Section titles: `你是谁/档案`, `人际`, `正在经历`, `目标`, `待跟进` (§6) | Task 1 |
| Empty facets produce no section (§6 — `pushSection` guard) | Task 1 (test + `pushSection` already skips empty) |
| Project-template non-regression: 6 PM slots unchanged (§2, §7) | Task 1 (test), Task 6 (E2E test) |
| `consistencyCheck` extended to cover profile write-protected identity (§5e) | Task 5 (`profile_identity_contradiction`) |
| Probe B2 north-star: `字节跳动` in runtime State block (§1, §7 Stage 1 acceptance) | Task 6 (E2E test assertion) |
| Benchmark non-regression: `consistencyPassRate` / `goldRetention` (§7, §10) | Task 6 (step 6.4) |
