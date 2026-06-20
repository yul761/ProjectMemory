# P2b-v1 — Explicit Style Preferences (养成 v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire explicit user communication-style preferences ("回短点" / "别用emoji" / "用中文回我") through a new `style_preference` entity type → `DigestState.profile.style` facet (volatile, recency-wins, cap 6) → rendered into the runtime system prompt between the seed persona and the base grounding instructions. Style is a voice signal; it stays out of the State memory block entirely.

**Architecture:** Three-layer change. (1) Storage: add `style` facet to `DigestState.profile` in both the TypeScript interface (`digest-control.ts`) and Zod contract (`contracts/index.ts`); add `style_preference` to `PROFILE_FACET_ROUTING` (volatile, cap 6, `writeProtected: false`); add `style_preference` entity type and classifier guidance in `personal.ts`. (2) Rendering: extend `buildRuntimeSystemPrompt` to a 3-param signature `(persona, styleLines, base)` that injects an optional "交流风格（用户要求）:" section between persona and base; update all P2a call sites and tests in the same change. (3) Controller wiring: `executeRuntimeTurn` loads `getLatestDigestState(scopeId)` in parallel with the scope lookup, extracts `profile.style`, and threads it through `createRuntimeSession` → `buildRuntimeSystemPrompt`. `compileStateLayerView` is intentionally untouched — style is voice, not State block.

**Tech Stack:** TypeScript, NestJS, Vitest, pnpm monorepo.

## Global Constraints

- **style → system prompt (voice), NOT State block.** `profile.style` exists in `DigestState.profile` but is NOT added to `StateLayerView`, `compileStateLayerView`, or `formatStateLayerView`. A dedicated test asserts `compileStateLayerView` output has no `style` key.
- **recency-wins, not write-protected.** `style_preference` must use the volatile path (`writeProtected: false`), cap 6, evict oldest (index 0) when full. Style preferences can change ("回短点" → "可以详细点").
- **only explicit statements.** `classificationSystemPrompt` must emphasize direct instructions only; one-off behavioral noise ("今天比较忙") → `noise`, not `style_preference`.
- **do NOT touch** `/memory/answer` (`answerSystemPrompt`, ~line 846 of `memory.controller.ts`), `relationship-context.ts`, or `StateLayerView` shape.
- **base always last** in `buildRuntimeSystemPrompt` — grounding rules must remain authoritative.
- **single signature, no overloads.** Change `buildRuntimeSystemPrompt` to 3 params; update the P2a call site and both existing test files in the same commit.
- **Node toolchain:** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`. Tests: `pnpm --filter @statecore/core test -- <pat>` / `pnpm --filter @statecore/api test -- <pat>`. Full build: `pnpm build` (tsc, must exit 0).

---

## Task 1 — Style Channel: Storage + Routing

### Files
- `packages/core/src/digest-control.ts` — `DigestState.profile` interface (~lines 49-55); `PROFILE_FACET_ROUTING` (~lines 1056-1063); `normalizeDigestState` profile-capping block (~lines 296-304)
- `packages/contracts/src/index.ts` — `DigestState` Zod schema `profile` object (~lines 497-503)
- `packages/core/src/domain-configs/personal.ts` — `entityTypes` array + `classificationSystemPrompt`
- `packages/core/src/digest-control.test.ts` — add Stage 4 style-routing tests
- `packages/core/src/working-memory.compiler.test.ts` — add no-style-in-StateLayerView test

### Interfaces

**Consumes:** `MemoryEvent.classifiedType === "style_preference"` with `content` = the raw preference text (e.g. "回短点", "别用emoji").

**Produces:**
- `DigestState.profile.style?: string[]` — up to 6 volatile recency-ordered style preferences
- `PROFILE_FACET_ROUTING["style_preference"] = { facet: "style", cap: 6, writeProtected: false }` routes through the existing volatile branch of `mergeProfileFacets` (dedup via `sameFactCjkAware` at 0.6, evict index 0 at cap)
- `normalizeDigestState` caps `profile.style` at 6
- Zod `DigestState.profile` schema accepts `style: z.array(z.string()).optional()`

---

- [ ] **Step 1.1 — Write failing tests: Stage 4 style routing**

Add to `packages/core/src/digest-control.test.ts` after the "Stage 3" describe block (note: `compileStateLayerView` is already imported at line 16 of this file — no new import needed):

```typescript
// Stage 4 — style_preference facet routing (P2b-v1)
// ---------------------------------------------------------------------------
describe("Stage 4 — style_preference facet routing", () => {
  function streamEvent(id: string, content: string, classifiedType?: string): MemoryEvent {
    return event({ id, scopeId: "sc", userId: "u", type: "stream", content, classifiedType: classifiedType ?? null });
  }

  function delta(id: string, content: string, classifiedType?: string): import("./digest-control").DeltaCandidate {
    return {
      eventId: id,
      reason: "novel_event",
      features: { kind: "note", importanceScore: 0.6, noveltyScore: 0.9 },
      event: streamEvent(id, content, classifiedType)
    };
  }

  // Test 1: style_preference → profile.style, NOT in factRegistry, evictable at cap 6
  it("classifiedType:style_preference routes to profile.style, not fact-registry, evictable at cap 6", () => {
    const prefs = ["回短点", "别用emoji", "用中文回我", "别太正式", "简洁优先", "不要废话", "保持简短"];
    const candidates = prefs.map((p, i) => delta(`sp-${i}`, p, "style_preference"));
    const state = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: candidates
    });
    // Must be in profile.style
    expect(state.profile?.style).toBeDefined();
    // Capped at 6 — first entry ("回短点") evicted
    expect((state.profile?.style ?? []).length).toBe(6);
    expect(state.profile?.style).not.toContain("回短点"); // oldest evicted
    expect(state.profile?.style).toContain("保持简短");   // newest kept
    // Must NOT appear in factRegistry (volatile path — no write-protection)
    const inRegistry = (state.factRegistry ?? []).some((e) => e.facet === "style");
    expect(inRegistry).toBe(false);
  });

  // Test 2: dedup — near-identical style prefs collapse to 1 entry
  it("near-identical style_preference entries dedup to 1 entry via CJK-aware Jaccard", () => {
    // "回复简短一点" and "回复简短" share bigrams 回复,复简,简短 → Jaccard 3/5 = 0.6 >= threshold
    const state = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [
        delta("sp-a", "回复简短一点", "style_preference"),
        delta("sp-b", "回复简短", "style_preference")
      ]
    });
    expect((state.profile?.style ?? []).length).toBe(1);
  });

  // Test 3: feeling / noise do NOT pollute profile.style
  it("feeling and noise events do NOT appear in profile.style", () => {
    const state = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [
        delta("f1", "今天很开心", "feeling"),
        delta("n1", "好的", "noise")
      ]
    });
    expect(state.profile?.style).toBeUndefined();
  });
});
```

Add to `packages/core/src/working-memory.compiler.test.ts` (after the last `it()` in the existing describe, or as a new describe):

```typescript
describe("compileStateLayerView — style exclusion (P2b)", () => {
  it("output never has a style field — style is system-prompt voice, not State block", () => {
    // Even with all other profile facets populated, style must not appear in the view
    const view = compileStateLayerView({
      profile: {
        identity: ["test user"],
        relationships: ["Sarah is a friend"],
        ongoing: ["job hunting"],
        goals: ["learn Spanish"],
        followUps: ["call mom Friday"]
      }
    });
    expect("style" in view).toBe(false);
    const viewKeys = Object.keys(view);
    expect(viewKeys).not.toContain("style");
  });
});
```

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test -- "Stage 4"`
Expected: FAIL — `style_preference` not yet in `PROFILE_FACET_ROUTING`; `profile.style` stays undefined.

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test -- "working-memory.compiler"`
Expected: The new "style exclusion" test PASSES immediately (since `compileStateLayerView` never emitted style before either).

- [ ] **Step 1.2 — Add `style` to `DigestState` interface in digest-control.ts**

In `packages/core/src/digest-control.ts` at the `profile?` block (~lines 49-55):

BEFORE:
```typescript
  profile?: {
    identity?: string[];
    relationships?: string[];
    ongoing?: string[];
    goals?: string[];
    followUps?: string[];
  };
```

AFTER:
```typescript
  profile?: {
    identity?: string[];
    relationships?: string[];
    ongoing?: string[];
    goals?: string[];
    followUps?: string[];
    style?: string[];
  };
```

- [ ] **Step 1.3 — Add `style_preference` to `PROFILE_FACET_ROUTING`**

In `packages/core/src/digest-control.ts` at `PROFILE_FACET_ROUTING` (~lines 1056-1063):

BEFORE:
```typescript
const PROFILE_FACET_ROUTING: Record<string, { facet: keyof NonNullable<DigestState["profile"]>; cap: number; writeProtected: boolean }> = {
  personal_detail: { facet: "identity", cap: 15, writeProtected: true },
  goal: { facet: "goals", cap: 8, writeProtected: true },
  life_decision: { facet: "goals", cap: 8, writeProtected: true },
  experience: { facet: "ongoing", cap: 8, writeProtected: false },
  person_note: { facet: "relationships", cap: 10, writeProtected: false },
  commitment: { facet: "followUps", cap: 10, writeProtected: false }
};
```

AFTER:
```typescript
const PROFILE_FACET_ROUTING: Record<string, { facet: keyof NonNullable<DigestState["profile"]>; cap: number; writeProtected: boolean }> = {
  personal_detail: { facet: "identity", cap: 15, writeProtected: true },
  goal: { facet: "goals", cap: 8, writeProtected: true },
  life_decision: { facet: "goals", cap: 8, writeProtected: true },
  experience: { facet: "ongoing", cap: 8, writeProtected: false },
  person_note: { facet: "relationships", cap: 10, writeProtected: false },
  commitment: { facet: "followUps", cap: 10, writeProtected: false },
  style_preference: { facet: "style", cap: 6, writeProtected: false }
};
```

Note: `"style"` is now a valid `keyof NonNullable<DigestState["profile"]>` because Step 1.2 added `style?: string[]` to the interface. The existing `mergeProfileFacets` volatile branch handles dedup and eviction automatically — no other code changes needed in that function.

- [ ] **Step 1.4 — Add style cap to `normalizeDigestState` profile block**

In `packages/core/src/digest-control.ts` at the profile block in `normalizeDigestState` (~lines 296-304):

BEFORE:
```typescript
    profile: (base as DigestState).profile
      ? {
          identity: ((base as DigestState).profile!.identity ?? []).slice(0, 15),
          relationships: ((base as DigestState).profile!.relationships ?? []).slice(0, 10),
          ongoing: ((base as DigestState).profile!.ongoing ?? []).slice(0, 8),
          goals: ((base as DigestState).profile!.goals ?? []).slice(0, 8),
          followUps: ((base as DigestState).profile!.followUps ?? []).slice(0, 10)
        }
      : undefined
```

AFTER:
```typescript
    profile: (base as DigestState).profile
      ? {
          identity: ((base as DigestState).profile!.identity ?? []).slice(0, 15),
          relationships: ((base as DigestState).profile!.relationships ?? []).slice(0, 10),
          ongoing: ((base as DigestState).profile!.ongoing ?? []).slice(0, 8),
          goals: ((base as DigestState).profile!.goals ?? []).slice(0, 8),
          followUps: ((base as DigestState).profile!.followUps ?? []).slice(0, 10),
          style: ((base as DigestState).profile!.style ?? []).slice(0, 6)
        }
      : undefined
```

- [ ] **Step 1.5 — Add `style` to Zod `DigestState.profile` in contracts/src/index.ts**

In `packages/contracts/src/index.ts` at the `profile` Zod object (~lines 497-503):

BEFORE:
```typescript
  profile: z.object({
    identity: z.array(z.string()).optional(),
    relationships: z.array(z.string()).optional(),
    ongoing: z.array(z.string()).optional(),
    goals: z.array(z.string()).optional(),
    followUps: z.array(z.string()).optional()
  }).optional()
```

AFTER:
```typescript
  profile: z.object({
    identity: z.array(z.string()).optional(),
    relationships: z.array(z.string()).optional(),
    ongoing: z.array(z.string()).optional(),
    goals: z.array(z.string()).optional(),
    followUps: z.array(z.string()).optional(),
    style: z.array(z.string()).optional()
  }).optional()
```

- [ ] **Step 1.6 — Add `style_preference` entity type + classifier guidance in personal.ts**

In `packages/core/src/domain-configs/personal.ts`:

**Sub-step A:** `entityTypes` array — add after the `noise` entry (last item, before `],`):

BEFORE:
```typescript
    { name: "noise",         description: "Casual chatter with no lasting value",                                               retention: "discard",   driftProtected: false, conflictDetectable: false }
  ],
```

AFTER:
```typescript
    { name: "noise",         description: "Casual chatter with no lasting value",                                               retention: "discard",   driftProtected: false, conflictDetectable: false },
    { name: "style_preference",
      description: "An explicit user statement about how they want the assistant to communicate — length, emoji, language, formality, or tone. Must be a direct instruction, not incidental one-off behavior.",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false }
  ],
```

**Sub-step B:** `classificationSystemPrompt` — insert the `style_preference` bullet before "In Chinese:", and extend the Chinese examples line:

BEFORE (the final paragraph section):
```
In Chinese: "我叫..." → personal_detail. "我有..." (pet/possession) → personal_detail. "我是..." (job/identity) → personal_detail.
"我决定..."/"我要..." → life_decision or goal. "答应了..." → commitment.
Be conservative: when unsure between personal_detail and noise, prefer personal_detail for genuine self-descriptions.

Return JSON: { "entityType": string, "importance": number }`,
```

AFTER:
```
- style_preference: user's EXPLICIT instruction about how the assistant should communicate (length/emoji/language/formality/tone).
  Examples: "回短点" / "别用emoji" / "用中文回我" / "说话别太正式" / "keep it brief" / "no emojis please" / "don't be so formal"
  ONLY direct communication-style instructions count. NOT: "今天比较忙" (one-off context → noise), "ok thanks" (noise).
  Behavioral noise (replied short because busy) is NOT a style preference. Only explicit standing instructions.

In Chinese: "我叫..." → personal_detail. "我有..." (pet/possession) → personal_detail. "我是..." (job/identity) → personal_detail.
"我决定..."/"我要..." → life_decision or goal. "答应了..." → commitment.
"回短点"/"别用表情符号"/"用中文回我"/"说话别太正式" → style_preference.
Be conservative: when unsure between personal_detail and noise, prefer personal_detail for genuine self-descriptions.
When unsure between style_preference and noise, prefer noise unless the user is EXPLICITLY instructing communication style.

Return JSON: { "entityType": string, "importance": number }`,
```

- [ ] **Step 1.7 — Run Stage 4 tests to verify green**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test -- "Stage 4"`
Expected: All 3 Stage 4 tests GREEN.

Run full core test suite to confirm no regression:
`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test`
Expected: All pre-existing tests GREEN + 3 new Stage 4 tests + new working-memory.compiler test GREEN.

- [ ] **Step 1.8 — Verify build passes**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm build`
Expected: Exit 0, no TypeScript errors.

- [ ] **Step 1.9 — Commit Task 1**

```bash
git add packages/core/src/digest-control.ts \
        packages/contracts/src/index.ts \
        packages/core/src/domain-configs/personal.ts \
        packages/core/src/digest-control.test.ts \
        packages/core/src/working-memory.compiler.test.ts
git commit -m "$(cat <<'EOF'
feat(p2b): add style_preference facet routing to DigestState.profile.style

Adds style_preference entity type (volatile, cap 6, writeProtected:false)
to PROFILE_FACET_ROUTING, extends DigestState.profile interface and Zod
contract with style?: string[], caps it in normalizeDigestState, and adds
classifier guidance in personal.ts for explicit-only communication-style
instructions. compileStateLayerView remains untouched — style is voice.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Rendering + Controller Wiring

### Files
- `packages/core/src/runtime-system-prompt.ts` — change to 3-param signature (~11 lines total)
- `packages/core/src/runtime-system-prompt.test.ts` — update 5 P2a tests to 3-param + add style-section tests
- `apps/api/src/persona-resolution.test.ts` — update 2 call sites to 3-param + add style-behavior tests
- `apps/api/src/memory.controller.ts` — add `styleLines` param to `createRuntimeSession` (~line 308); update `buildRuntimeSystemPrompt` call (~line 340); load digest snapshot + thread `styleLines` in `executeRuntimeTurn` (~lines 417-426)

### Interfaces

**Consumes:**
- New `buildRuntimeSystemPrompt(persona: string|null|undefined, styleLines: string[]|null|undefined, base: string): string`
- `this.domain.getLatestDigestState(scopeId): Promise<{ digestId: string; state: DigestState; consistency: ...; createdAt: Date } | null>` — already exists in `domain.service.ts:291`

**Produces:**
- Composed prompt: `[persona]\n\n交流风格（用户要求）:\n- line1\n- line2\n\n[base]` when both present
- Falls back to P2a behavior (`[persona]\n\n[base]`) when `styleLines` is empty/null
- Falls back to base-only when both persona and styleLines are absent/empty
- `base` is always the last segment (grounding authority)

---

- [ ] **Step 2.1 — Write failing tests for new 3-param signature and style section**

Replace `packages/core/src/runtime-system-prompt.test.ts` entirely:

```typescript
import { describe, expect, it } from "vitest";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt";

const BASE = "You are the synchronous Fast Layer assistant.\nKeep replies concise.";
const PERSONA = "You are a warm, attentive personal AI companion.";

describe("buildRuntimeSystemPrompt", () => {
  // ── P2a cases (updated to 3-param, styleLines=null) ──────────────────────
  it("prepends persona before base when persona is present and no styleLines", () => {
    const out = buildRuntimeSystemPrompt(PERSONA, null, BASE);
    expect(out).toBe(`${PERSONA}\n\n${BASE}`);
    expect(out.startsWith(PERSONA)).toBe(true);  // persona first (voice)
    expect(out.endsWith(BASE)).toBe(true);        // base last (authoritative)
  });

  it("trims surrounding whitespace on persona", () => {
    const out = buildRuntimeSystemPrompt("  hello persona  ", null, BASE);
    expect(out).toBe(`hello persona\n\n${BASE}`);
  });

  it("returns base verbatim when persona is null and no styleLines", () => {
    expect(buildRuntimeSystemPrompt(null, null, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is undefined and no styleLines", () => {
    expect(buildRuntimeSystemPrompt(undefined, null, BASE)).toBe(BASE);
  });

  it("returns base verbatim when persona is empty or whitespace-only and no styleLines", () => {
    expect(buildRuntimeSystemPrompt("", null, BASE)).toBe(BASE);
    expect(buildRuntimeSystemPrompt("   ", null, BASE)).toBe(BASE);
  });

  // ── P2b cases: style section ──────────────────────────────────────────────
  it("renders style section between persona and base when both are present", () => {
    const styleLines = ["回复简短", "用中文"];
    const out = buildRuntimeSystemPrompt(PERSONA, styleLines, BASE);
    const expected = `${PERSONA}\n\n交流风格（用户要求）:\n- 回复简短\n- 用中文\n\n${BASE}`;
    expect(out).toBe(expected);
    expect(out.startsWith(PERSONA)).toBe(true);  // persona first
    expect(out.endsWith(BASE)).toBe(true);        // base always last
  });

  it("renders style section before base when persona is null", () => {
    const styleLines = ["别用emoji"];
    const out = buildRuntimeSystemPrompt(null, styleLines, BASE);
    const expected = `交流风格（用户要求）:\n- 别用emoji\n\n${BASE}`;
    expect(out).toBe(expected);
    expect(out.endsWith(BASE)).toBe(true);
  });

  it("returns base verbatim when styleLines is an empty array", () => {
    expect(buildRuntimeSystemPrompt(null, [], BASE)).toBe(BASE);
  });

  it("returns base verbatim when styleLines is undefined", () => {
    expect(buildRuntimeSystemPrompt(null, undefined, BASE)).toBe(BASE);
  });

  it("trims whitespace-only styleLines entries and skips them", () => {
    const out = buildRuntimeSystemPrompt(null, ["  ", "用中文"], BASE);
    const expected = `交流风格（用户要求）:\n- 用中文\n\n${BASE}`;
    expect(out).toBe(expected);
  });

  it("base is always the last segment regardless of inputs", () => {
    const out = buildRuntimeSystemPrompt(PERSONA, ["回短点"], BASE);
    expect(out.endsWith(BASE)).toBe(true);
  });
});
```

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test -- runtime-system-prompt`
Expected: FAIL — current `buildRuntimeSystemPrompt` is 2-param; 3-arg calls fail TypeScript compilation.

- [ ] **Step 2.2 — Implement 3-param `buildRuntimeSystemPrompt`**

Replace `packages/core/src/runtime-system-prompt.ts` entirely:

BEFORE (full file):
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

AFTER (full file):
```typescript
/**
 * Compose the runtime-turn system prompt (P2a + P2b-v1).
 *
 * Segment order — empty segments are omitted:
 *   1. Seed persona — voice/character (P2a)
 *   2. 交流风格（用户要求）— explicit style preferences (P2b-v1, only when styleLines non-empty)
 *   3. Base operational/grounding instructions — ALWAYS last, always authoritative
 *
 * When persona is absent and styleLines is empty/null, base is returned unchanged
 * (project template P2a fallback — zero behavioural diff for non-personal scopes).
 */
export function buildRuntimeSystemPrompt(
  persona: string | null | undefined,
  styleLines: string[] | null | undefined,
  base: string
): string {
  const parts: string[] = [];

  const trimmedPersona = persona?.trim();
  if (trimmedPersona) parts.push(trimmedPersona);

  const activeStyles = (styleLines ?? []).map((s) => s.trim()).filter(Boolean);
  if (activeStyles.length > 0) {
    parts.push(`交流风格（用户要求）:\n${activeStyles.map((s) => `- ${s}`).join("\n")}`);
  }

  parts.push(base);
  return parts.join("\n\n");
}
```

- [ ] **Step 2.3 — Run core tests to verify new implementation passes**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/core test -- runtime-system-prompt`
Expected: All 10 tests GREEN.

- [ ] **Step 2.4 — Update `apps/api/src/persona-resolution.test.ts` to 3-param calls and add style-behavior tests**

Replace `apps/api/src/persona-resolution.test.ts` entirely:

BEFORE (full file):
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

AFTER (full file):
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
    const sys = buildRuntimeSystemPrompt(persona, null, BASE);
    expect(sys).not.toBe(BASE);          // persona was injected
    expect(sys.endsWith(BASE)).toBe(true);
  });

  it("project template yields no persona → base unchanged", () => {
    const persona = resolvePersona("project");
    expect(persona).toBeNull();
    expect(buildRuntimeSystemPrompt(persona, null, BASE)).toBe(BASE);
  });
});

describe("buildRuntimeSystemPrompt — style section (P2b)", () => {
  const PERSONA_PERSONAL = getDomainConfig("personal").defaultPersonaPrompt ?? null;

  it("profile.style array renders into composed system prompt between persona and base", () => {
    const styleLines = ["回复简短", "用中文"];
    const out = buildRuntimeSystemPrompt(PERSONA_PERSONAL, styleLines, BASE);
    expect(out).toContain("交流风格（用户要求）:");
    expect(out).toContain("- 回复简短");
    expect(out).toContain("- 用中文");
    // Ordering: persona first, base last, style in between
    expect(out.startsWith(PERSONA_PERSONAL!)).toBe(true);
    expect(out.endsWith(BASE)).toBe(true);
    const styleIdx = out.indexOf("交流风格");
    const baseIdx = out.lastIndexOf(BASE);
    expect(styleIdx).toBeGreaterThan(0);
    expect(baseIdx).toBeGreaterThan(styleIdx);
  });

  it("empty profile.style → P2a behavior (persona + base, no style section)", () => {
    const out = buildRuntimeSystemPrompt(PERSONA_PERSONAL, [], BASE);
    expect(out).not.toContain("交流风格");
    expect(out).toBe(`${PERSONA_PERSONAL}\n\n${BASE}`);
  });

  it("null profile.style → P2a behavior identical to empty array", () => {
    const outNull = buildRuntimeSystemPrompt(PERSONA_PERSONAL, null, BASE);
    const outEmpty = buildRuntimeSystemPrompt(PERSONA_PERSONAL, [], BASE);
    expect(outNull).toBe(outEmpty);
  });
});
```

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/api test -- persona-resolution`
Expected: All 5 tests GREEN.

- [ ] **Step 2.5 — Add `styleLines` param to `createRuntimeSession` and update the `buildRuntimeSystemPrompt` call**

In `apps/api/src/memory.controller.ts`:

**Sub-step A:** `createRuntimeSession` signature (~lines 299-308):

BEFORE:
```typescript
  private createRuntimeSession(
    userId: string,
    scopeId: string,
    policyProfile: "default" | "conservative" | "document-heavy",
    policyOverrides?: {
      recallLimit?: number;
      promoteLongFormToDocumented?: boolean;
      digestOnCandidate?: boolean;
    },
    personaPrompt?: string | null
  ) {
```

AFTER:
```typescript
  private createRuntimeSession(
    userId: string,
    scopeId: string,
    policyProfile: "default" | "conservative" | "document-heavy",
    policyOverrides?: {
      recallLimit?: number;
      promoteLongFormToDocumented?: boolean;
      digestOnCandidate?: boolean;
    },
    personaPrompt?: string | null,
    styleLines?: string[] | null
  ) {
```

**Sub-step B:** `buildRuntimeSystemPrompt` call inside `createRuntimeSession` (~line 340):

BEFORE:
```typescript
        system: buildRuntimeSystemPrompt(personaPrompt ?? null, runtimeSystemPrompt),
```

AFTER:
```typescript
        system: buildRuntimeSystemPrompt(personaPrompt ?? null, styleLines ?? null, runtimeSystemPrompt),
```

- [ ] **Step 2.6 — Load digest snapshot + thread `styleLines` in `executeRuntimeTurn`**

In `apps/api/src/memory.controller.ts` at `executeRuntimeTurn` (~lines 417-426):

BEFORE:
```typescript
    const policyProfile = input.policyProfile ?? "default";
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

AFTER:
```typescript
    const policyProfile = input.policyProfile ?? "default";
    const [scope, digestSnapshot] = await Promise.all([
      this.domain.projectService.getScope(userId, input.scopeId),
      this.domain.getLatestDigestState(input.scopeId)
    ]);
    const personaPrompt = getDomainConfig(scope?.template).defaultPersonaPrompt ?? null;
    const styleLines = digestSnapshot?.state?.profile?.style ?? null;
    const session = this.createRuntimeSession(
      userId,
      input.scopeId,
      policyProfile,
      input.policyOverrides,
      personaPrompt,
      styleLines
    );
```

Note: confirm the actual user-id variable name and the `getLatestDigestState` return shape against the real code; the brief verified `getLatestDigestState(scopeId)` exists (domain.service.ts) and returns `{ state: DigestState } | null`. If the method takes `(userId, scopeId)` or returns a differently-named field, adapt minimally to reach `state.profile.style`.

- [ ] **Step 2.7 — Run full api test suite + build**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm --filter @statecore/api test`
Expected: All tests GREEN (all pre-existing api tests + 5 persona-resolution tests).

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; pnpm build`
Expected: Exit 0, no TypeScript errors.

- [ ] **Step 2.8 — Commit Task 2**

```bash
git add packages/core/src/runtime-system-prompt.ts \
        packages/core/src/runtime-system-prompt.test.ts \
        apps/api/src/persona-resolution.test.ts \
        apps/api/src/memory.controller.ts
git commit -m "$(cat <<'EOF'
feat(p2b): extend buildRuntimeSystemPrompt to 3-param and wire style into runtime session

Changes buildRuntimeSystemPrompt(persona, base) → (persona, styleLines, base);
renders an optional 交流风格（用户要求）section between persona and base when
styleLines is non-empty. executeRuntimeTurn loads getLatestDigestState in
parallel with scope lookup, extracts profile.style, and passes it through
createRuntimeSession. Updates all P2a call sites and tests; P2a behavior
unchanged when styleLines is null/empty; base always last.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Benchmark Non-Regression Verification

### Files
- `scripts/benchmark/run-benchmark.mjs` — run only, do NOT modify
- `benchmark-fixtures/basic.json` — fixture used, do NOT modify
- `.env` — temporarily point `API_BASE_URL`→`http://127.0.0.1:3002` and `BENCH_USER_ID`→`local-dev-user` (the benchmark's `loadEnvFile` overrides CLI env), then restore. Do NOT persist `.env` changes.

### Interfaces
**Consumes:** Running API server at `http://127.0.0.1:3002`, `BENCH_FIXTURE=benchmark-fixtures/basic.json`, `BENCH_SEED=42`.
**Produces:** Console benchmark report; no regression in digest consistency / retention / runtimeGrounding / overall vs pre-P2b baseline (consistency 1.0, retention 1.0, runtimeGrounding ~15, overall 94).

---

- [ ] **Step 3.1 — Rebuild stack with the P2b wiring**

```bash
docker compose -f docker-compose.local.yml up -d --build api worker
# wait for health
curl -s localhost:3002/health | grep -o '"status":"ok"'
```
Expected: `"status":"ok"`.

- [ ] **Step 3.2 — Run benchmark (point .env at the running API, then restore)**

```bash
sed -i.bak 's#^API_BASE_URL=http://localhost:3000#API_BASE_URL=http://127.0.0.1:3002#; s#^BENCH_USER_ID=benchmark-user#BENCH_USER_ID=local-dev-user#' .env
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
BENCH_FIXTURE=benchmark-fixtures/basic.json BENCH_SEED=42 node scripts/benchmark/run-benchmark.mjs
mv .env.bak .env
```

- [ ] **Step 3.3 — Verify scores do not regress**

Read the latest `benchmark-results/*.json`. Expected vs the pre-P2b baseline:
- `metrics.digest.consistencyPassRate` = 1.0 (unchanged — digest path untouched)
- `metrics.digest.goldRetention.*` = 1.0 (unchanged)
- `reliabilityBreakdown.runtimeGrounding` not materially below ~15 (style only injects into the system prompt when profile.style is non-empty; the project-template benchmark scope has no style_preference events)
- `overall` ~94

**Why no regression is expected:** `style_preference` is a new volatile facet that only populates `profile.style` when an event is classified as `style_preference`; the basic fixture (project template) has none. The style section only renders when `profile.style` is non-empty. `compileStateLayerView`, retrieval, answer logic, and State-block serialization are all unchanged. Verification only — no commit.

---

## Self-Review: Spec Requirements → Tasks

| Spec Requirement | Task | Step(s) |
|---|---|---|
| `style_preference` entity type in personal.ts (explicit-only, long-term, driftProtected:false) | Task 1 | 1.6 |
| Classifier guidance: examples ("回短点" etc.), "only explicit statements" rule, behavioral noise → noise | Task 1 | 1.6 |
| `PROFILE_FACET_ROUTING["style_preference"] = { facet:"style", cap:6, writeProtected:false }` | Task 1 | 1.3 |
| `DigestState.profile.style?: string[]` TypeScript interface | Task 1 | 1.2 |
| Zod contract `DigestState.profile.style: z.array(z.string()).optional()` | Task 1 | 1.5 |
| `normalizeDigestState` caps `profile.style` at 6 | Task 1 | 1.4 |
| volatile path: dedup via `sameFactCjkAware` + evict oldest at cap (recency-wins) | Task 1 | 1.3 (routes through existing volatile branch in `mergeProfileFacets`) |
| `feeling` / `noise` do NOT pollute `profile.style` | Task 1 | 1.1 (Test 3) |
| `compileStateLayerView` output has no `style` field (State block excludes voice) | Task 1 | 1.1 (working-memory.compiler.test.ts new test) |
| `buildRuntimeSystemPrompt(persona, styleLines, base)` 3-param signature | Task 2 | 2.2 |
| 交流风格（用户要求）section: only when styleLines non-empty, between persona and base | Task 2 | 2.2 |
| base always last (grounding authority) | Task 2 | 2.2 |
| styleLines empty/null → P2a fallback | Task 2 | 2.1 + 2.2 |
| P2a existing tests stay green with new signature | Task 2 | 2.1 + 2.4 |
| `executeRuntimeTurn` loads `profile.style` from `getLatestDigestState` | Task 2 | 2.6 |
| `createRuntimeSession` threads `styleLines` | Task 2 | 2.5 |
| `/memory/answer` not touched; `relationship-context.ts` not touched | both | not modified |
| benchmark non-regression | Task 3 | 3.1–3.3 |
| `pnpm build` exit 0 | Task 1+2 | 1.8 + 2.7 |
