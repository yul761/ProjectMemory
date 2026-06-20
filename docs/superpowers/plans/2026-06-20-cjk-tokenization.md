# CJK Bigram Tokenization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CJK (Chinese/Japanese/Korean) word-level recall in StateCore's heuristic retrieval layer by adding bigram segmentation to `RetrieveService.tokenize`, without depending on the embedding API.

**Architecture:** `RetrieveService.tokenize` currently strips all non-ASCII to spaces, so CJK collapses to empty tokens and retrieval degrades to recency-only. We add a second tokenization path that extracts contiguous CJK runs and emits adjacent bigrams (single-char runs kept as unigrams), merged with the existing ASCII word path. The Jaccard-style scorer (`explainQueryScore`) consumes bigrams as ordinary tokens — no scoring changes. Drift-protection's separate tokenizer (`digest-control.ts`) is untouched.

**Tech Stack:** TypeScript, Vitest, pnpm. Package: `packages/core`.

## Global Constraints

- Only `packages/core/src/index.ts` `RetrieveService.tokenize` (lines 291-297) may change. Do NOT modify `queryAliases`, `explainQueryScore` scoring math, the embedding path, or `digest-control.ts`.
- ASCII/Latin tokenization behavior must remain byte-for-byte equivalent for non-CJK input (existing English tests must stay green).
- CJK Unicode ranges: Chinese `一-鿿`, Japanese kana `぀-ヿ`, Korean syllables `가-힯`.
- CJK tokens (bigrams length 2, single chars length 1) must NOT be dropped by the existing `length > 2` filter.
- Spec: `docs/superpowers/specs/2026-06-20-cjk-tokenization-design.md`.

---

### Task 1: Add CJK bigram path to `RetrieveService.tokenize`

**Files:**
- Modify: `packages/core/src/index.ts:291-297` (`RetrieveService.tokenize`)
- Test: `packages/core/src/retrieve-cjk.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RetrieveService.tokenize(text: string): string[]` — same signature, now also emits CJK bigrams/unigrams. `tokenize` and `explainQueryScore` are currently `private`; tests reach them via `as any` casts (see Step 1). Public `retrieve()` behavior unchanged.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/retrieve-cjk.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { RetrieveService } from "./index";

// tokenize/explainQueryScore are private; construct with nulls (we never call DB paths) and reach in via casts.
function svc() {
  return new RetrieveService(null as any, null as any) as any;
}

describe("RetrieveService CJK tokenization", () => {
  it("emits adjacent bigrams for a Chinese run", () => {
    const tokens: string[] = svc().tokenize("我对花生过敏");
    expect(tokens).toContain("花生");
    expect(tokens).toContain("过敏");
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("recalls a Chinese fact via shared bigrams", () => {
    const { score } = svc().explainQueryScore("我对什么过敏", "我对花生过敏");
    expect(score).toBeGreaterThan(0);
  });

  it("kills the character-count false positive (regression: discussion §12.2)", () => {
    const { score } = svc().explainQueryScore("我喜欢打篮球", "我对花生过敏");
    expect(score).toBe(0);
  });

  it("does not degrade English word tokenization", () => {
    const tokens: string[] = svc().tokenize("I am allergic to peanuts");
    expect(tokens).toContain("allergic");
    expect(tokens).toContain("peanuts");
    expect(tokens).not.toContain("am"); // length > 2 filter still applies to ASCII
  });

  it("handles mixed script", () => {
    const tokens: string[] = svc().tokenize("上传resume");
    expect(tokens).toContain("resume");
    expect(tokens).toContain("上传");
  });

  it("keeps a single CJK character as a unigram", () => {
    const tokens: string[] = svc().tokenize("钱");
    expect(tokens).toContain("钱");
  });

  it("smoke-tests Japanese and Korean bigrams", () => {
    expect(svc().tokenize("ともだち")).toContain("とも"); // hiragana
    expect(svc().tokenize("친구만나다")).toContain("친구"); // hangul
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @statecore/core test -- retrieve-cjk`
Expected: FAIL — Chinese tests fail (`tokens` empty / `score` is 0 for the recall case; the false-positive test may currently pass by accident, that is fine). If the filter name `@statecore/core` is wrong, find it via `node -e "console.log(require('./packages/core/package.json').name)"` and use that.

- [ ] **Step 3: Implement the CJK bigram path**

Replace `RetrieveService.tokenize` (currently lines 291-297) with:

```typescript
  private tokenize(text: string) {
    const lower = text.toLowerCase();
    const asciiTokens = lower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2);
    const cjkTokens: string[] = [];
    // Contiguous runs of CJK ideographs / Japanese kana / Korean syllables.
    const runs = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
    for (const run of runs) {
      if (run.length === 1) {
        cjkTokens.push(run); // single-char run: keep as unigram
        continue;
      }
      for (let i = 0; i < run.length - 1; i += 1) {
        cjkTokens.push(run.slice(i, i + 2)); // adjacent bigram
      }
    }
    return [...asciiTokens, ...cjkTokens];
  }
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pnpm --filter @statecore/core test -- retrieve-cjk`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Run the existing retrieve/index suites to verify no regression**

Run: `pnpm --filter @statecore/core test -- index retrieve-embedding retrieve-vector`
Expected: PASS — existing English/embedding/vector behavior unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/retrieve-cjk.test.ts
git commit -m "feat(retrieve): add CJK bigram tokenization for heuristic recall

Chinese/Japanese/Korean previously collapsed to empty tokens (recency-only
retrieval). Extract contiguous CJK runs and emit adjacent bigrams so the
Jaccard scorer recalls shared substrings without the embedding API.
Kills the §12.2 character-count false positive. Scoped to
RetrieveService.tokenize; drift-protection Jaccard untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: End-to-end probe verification (embedding OFF)

**Files:**
- Run only: `scripts/diagnostics/forgetting-probe.mjs` (no edits expected)

**Interfaces:**
- Consumes: `RetrieveService.tokenize` from Task 1.
- Produces: quantified before/after recall numbers to record in the discussion log.

- [ ] **Step 1: Bring up the stack with embeddings disabled**

In `.env` set `RETRIEVE_USE_EMBEDDINGS=false` (temporarily, to isolate the bigram path's standalone value). Then:

```bash
docker compose -f docker-compose.local.yml up -d --build api worker
curl -s localhost:3002/health
```
Expected: health JSON; `retrieve.useEmbeddings` false.

- [ ] **Step 2: Run the probe**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
node scripts/diagnostics/forgetting-probe.mjs
```
Expected: Chinese near-synonym queries that were recency-only before now surface the old fact via bigram overlap (rank improves into top-2). Record the rank table.

- [ ] **Step 3: Restore embedding setting**

Set `RETRIEVE_USE_EMBEDDINGS=true` back in `.env` (the product default for the Chinese use case per discussion §12.7). No commit — `.env` is gitignored.

- [ ] **Step 4: Append results to the discussion log**

Add a short subsection to `/Users/yuchenlin/Quatium/StateCore/StateCore-记忆引擎-讨论记录.md` recording the embedding-OFF before/after ranks and confirming the §12.2 false positive stays dead. (This file lives outside the repo — no git commit.)

---

## Self-Review

**Spec coverage:**
- Spec §4.1 ASCII path preserved → Task 1 Step 3 keeps the exact existing chain; Test 4 guards it. ✓
- Spec §4.2 CJK bigrams + single-char unigram → Task 1 Step 3; Tests 1, 6, 7. ✓
- Spec §4.3 merge + mixed script → Task 1 Step 3 returns concatenation; Test 5. ✓
- Spec §4.4 no scoring change → Global Constraints forbid touching `explainQueryScore`. ✓
- Spec §5 test table → Tests 1-7 map 1:1; E2E probe = Task 2. ✓
- Spec §6 known boundary (loose synonyms) → not implemented by design; not tested (correct). ✓
- Spec §7 acceptance: tests green (Task 1 S4), no regression (Task 1 S5), probe quantified (Task 2), Jaccard untouched (Global Constraints). ✓

**Placeholder scan:** No TBD/TODO; all code shown in full. ✓

**Type consistency:** `tokenize` returns `string[]` throughout; `explainQueryScore` returns `{ score, ... }` matching existing signature at `index.ts:303`. ✓
