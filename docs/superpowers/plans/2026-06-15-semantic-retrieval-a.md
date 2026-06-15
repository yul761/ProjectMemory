# Semantic Retrieval — Option A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate and validate the existing embedding reranking path in `RetrieveService` — fix silent error swallowing, add unit tests proving the hybrid ranking works, add a skipped integration test, and document the configuration.

**Architecture:** `RetrieveService.rerankWithEmbeddings()` already implements hybrid ranking (embedding 0.55 + text 0.25 + recency 0.20) but its `catch {}` block is silent and the path has no tests. This plan adds `logger.warn` to the catch block, three unit tests via mock `EmbeddingModel`, one skipped real-API integration test, and commented env var documentation in `docker-compose.local.yml` and `CLAUDE.md`.

**Tech Stack:** TypeScript, Vitest, pino logger, OpenAI-compatible embeddings API (`/embeddings` endpoint), pnpm workspaces.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/index.ts` | Modify ~line 397 | Add `logger.warn` to `rerankWithEmbeddings` catch block |
| `packages/core/src/retrieve-embedding.test.ts` | Create | 3 unit tests with mock EmbeddingModel |
| `packages/core/src/retrieve-embedding.integration.test.ts` | Create | 1 `it.skip` real-API integration test |
| `docker-compose.local.yml` | Modify | Add commented embedding env var block to api service |
| `CLAUDE.md` | Modify | Document optional semantic retrieval config |

---

## Key Types (no need to import separately — all from `./index`)

```typescript
// RetrieveService constructor:
new RetrieveService(
  digestRepo: DigestRepo,    // { findLatest: (scopeId) => Promise<Digest | null>, listRecent: ... }
  memoryRepo: MemoryRepo,    // { listRecent: (scopeId, limit) => Promise<{ items: MemoryEvent[], nextCursor: string | null }> }
  options?: {
    embeddingModel?: EmbeddingModel | null;  // { embed: (input: string[]) => Promise<number[][]> }
    useEmbeddingRerank?: boolean;
    embeddingCandidateLimit?: number;
  }
)

// retrieve() return shape (relevant fields):
result.retrieval.mode          // "hybrid" | "heuristic"
result.retrieval.reranked      // boolean — true if any item changed position
result.retrieval.matches[]     // { id, heuristicScore, finalScore, rankingReason, embeddingScore? }
result.events[]                // MemoryEvent[] — the actual events in ranked order
```

---

## Task 1: Fix logger.warn + unit tests

**Files:**
- Modify: `packages/core/src/index.ts` (~line 397, the `catch {}` in `rerankWithEmbeddings`)
- Create: `packages/core/src/retrieve-embedding.test.ts`

### Step 1: Write the failing tests

Create `packages/core/src/retrieve-embedding.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { RetrieveService } from "./index";
import type { MemoryEvent } from "./index";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "content">): MemoryEvent {
  return {
    scopeId: "sc",
    userId: "u",
    type: "stream",
    source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

function mockRepos(events: MemoryEvent[]) {
  return {
    digestRepo: { findLatest: vi.fn().mockResolvedValue(null), listRecent: vi.fn() } as any,
    memoryRepo: { listRecent: vi.fn().mockResolvedValue({ items: events, nextCursor: null }) } as any
  };
}

describe("RetrieveService — embedding reranking", () => {
  it("promotes semantically similar event above keyword-ranked event", async () => {
    // event1 is older (lower recency) with no keyword match to query
    // event2 is newer (higher recency) with no keyword match to query
    // Without embedding: event2 ranks first (newer)
    // With embedding: event1 gets cosine ≈ 0.99, event2 gets cosine ≈ 0.11 → event1 should win
    const e1 = event({ id: "e1", content: "unrelated alpha", createdAt: new Date("2026-01-01T10:00:00Z") });
    const e2 = event({ id: "e2", content: "unrelated beta",  createdAt: new Date("2026-01-01T10:01:00Z") });
    const { digestRepo, memoryRepo } = mockRepos([e1, e2]);

    const embeddingModel = {
      embed: vi.fn().mockResolvedValue([
        [1, 0, 0],       // query vector
        [0.1, 0.9, 0],   // e2 vector (low cosine with query — e2 is first in keyword order)
        [0.9, 0.1, 0]    // e1 vector (high cosine with query — e1 is second in keyword order)
      ])
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 2, "xyzzy");

    expect(result.events[0].id).toBe("e1");
    expect(result.retrieval.mode).toBe("hybrid");
    expect(result.retrieval.reranked).toBe(true);
    const e1Match = result.retrieval.matches.find((m) => m.id === "e1");
    expect(e1Match?.embeddingScore).toBeDefined();
    expect(e1Match?.rankingReason).toContain("embedding_rerank");
  });

  it("falls back to keyword ranking when embedding model throws", async () => {
    const e1 = event({ id: "e1", content: "unrelated alpha", createdAt: new Date("2026-01-01T10:00:00Z") });
    const e2 = event({ id: "e2", content: "unrelated beta",  createdAt: new Date("2026-01-01T10:01:00Z") });
    const { digestRepo, memoryRepo } = mockRepos([e1, e2]);

    const embeddingModel = {
      embed: vi.fn().mockRejectedValue(new Error("API timeout"))
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    // Should not throw — falls back gracefully
    const result = await service.retrieve("sc", 2, "xyzzy");

    // Keyword order: e2 first (newer, higher recency score)
    expect(result.events[0].id).toBe("e2");
    // No embeddingScore on matches
    expect(result.retrieval.matches[0].embeddingScore).toBeUndefined();
    expect(result.retrieval.matches[0].rankingReason).toContain("heuristic_rank");
    // Mode is still "hybrid" (it's configured), but reranked is false
    expect(result.retrieval.mode).toBe("hybrid");
    expect(result.retrieval.reranked).toBe(false);
  });

  it("embeddingScore reflects cosine similarity — perfect match scores 1.0 and drives finalScore", async () => {
    // Single event, query with no keyword match, embedding cosine = 1.0
    // recency = 0 (single event), textScore ≈ 0 (no keyword overlap)
    // finalScore ≈ 1.0 * 0.55 + 0 * 0.25 + 0 * 0.20 = 0.55
    const e1 = event({ id: "e1", content: "anything here" });
    const { digestRepo, memoryRepo } = mockRepos([e1]);

    const embeddingModel = {
      embed: vi.fn().mockResolvedValue([
        [1, 0, 0],  // query vector
        [1, 0, 0]   // e1 vector — cosine similarity = 1.0 (perfect match)
      ])
    };

    const service = new RetrieveService(digestRepo, memoryRepo, {
      useEmbeddingRerank: true,
      embeddingModel,
      embeddingCandidateLimit: 5
    });

    const result = await service.retrieve("sc", 1, "xyzzy");
    const match = result.retrieval.matches[0];

    expect(match.embeddingScore).toBeCloseTo(1.0, 2);
    expect(match.finalScore).toBeCloseTo(0.55, 1); // 1.0*0.55 + ~0*0.25 + 0*0.20
  });
});
```

### Step 2: Run tests to verify they fail

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test -- retrieve-embedding 2>&1 | Select-Object -Last 20
```

Expected: 3 tests fail. Test 1 and 3 fail because `rerankWithEmbeddings` catch block is silent (no logger.warn doesn't matter here) — actually tests 1 and 3 should PASS already since the code is implemented. Test 2 should also pass (catch returns ranked). 

**If all 3 tests pass immediately:** that's fine — the tests are verifying existing correct behavior. Skip to Step 4 (fix logger.warn), then verify tests still pass.

**If any test fails:** The embedding code has a bug. Read the failure and investigate `rerankWithEmbeddings` in `packages/core/src/index.ts` around line 346–400.

### Step 3: Fix silent error swallowing

In `packages/core/src/index.ts`, find the `rerankWithEmbeddings` method. Near the end, find:

```typescript
    } catch {
      return ranked;
    }
```

Replace with:

```typescript
    } catch (err) {
      logger.warn({ err }, "Embedding rerank failed, falling back to heuristic ranking");
      return ranked;
    }
```

`logger` is already imported in this file — do NOT add a new import.

### Step 4: Run full test suite

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 10
```

Expected: 153 tests pass (150 existing + 3 new). Zero failures.

### Step 5: Commit

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/retrieve-embedding.test.ts packages/core/src/index.ts
git commit -m "fix(retrieve): log warning on embedding rerank failure; add embedding rerank unit tests"
```

---

## Task 2: Integration test (skipped)

**Files:**
- Create: `packages/core/src/retrieve-embedding.integration.test.ts`

### Step 1: Create the file

Create `packages/core/src/retrieve-embedding.integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { RetrieveService, createModelProvider } from "./index";
import type { MemoryEvent } from "./index";

// Run manually with a real API key:
//   $env:MODEL_EMBEDDING_NAME="text-embedding-3-small"
//   $env:OPENAI_API_KEY="sk-..."
//   pnpm --filter @statecore/core test -- retrieve-embedding.integration --run

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "content">): MemoryEvent {
  return {
    scopeId: "sc", userId: "u", type: "stream", source: "api",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial
  };
}

describe("RetrieveService — real embedding integration", () => {
  it.skip("requires OPENAI_API_KEY + MODEL_EMBEDDING_NAME: semantic query ranks relevant event above unrelated event", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.MODEL_EMBEDDING_NAME ?? "text-embedding-3-small";
    if (!apiKey) throw new Error("Set OPENAI_API_KEY to run this test");

    const provider = createModelProvider({
      provider: "openai-compatible",
      apiKey,
      baseUrl: "https://api.openai.com/v1",
      model: modelName,
      embeddingModel: modelName,
      embeddingApiKey: apiKey,
      embeddingBaseUrl: "https://api.openai.com/v1"
    });

    const relevant = event({ id: "relevant", content: "We decide to use Postgres for the database" });
    const noise = event({ id: "noise", content: "The weather outside is quite nice today" });

    const service = new RetrieveService(
      { findLatest: async () => null, listRecent: async () => ({ items: [], nextCursor: null }) } as any,
      { listRecent: async () => ({ items: [relevant, noise], nextCursor: null }) } as any,
      {
        useEmbeddingRerank: true,
        embeddingModel: provider?.embedding ?? undefined,
        embeddingCandidateLimit: 10
      }
    );

    const result = await service.retrieve("sc", 2, "what persistence layer did we choose?");

    // Semantically relevant event should rank first despite no keyword overlap
    expect(result.events[0].id).toBe("relevant");
    expect(result.retrieval.reranked).toBe(true);

    const relevantMatch = result.retrieval.matches.find((m) => m.id === "relevant");
    const noiseMatch = result.retrieval.matches.find((m) => m.id === "noise");
    expect(relevantMatch?.embeddingScore).toBeGreaterThan(noiseMatch?.embeddingScore ?? 0);
  });
});
```

### Step 2: Run to verify it's skipped (not erroring)

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 10
```

Expected: 153 pass, 1 skip (the integration test). Zero failures.

### Step 3: Commit

```powershell
cd C:\StateCore\StateCore
git add packages/core/src/retrieve-embedding.integration.test.ts
git commit -m "test(core): add skipped embedding integration test — run with real OPENAI_API_KEY"
```

---

## Task 3: Configuration documentation

**Files:**
- Modify: `docker-compose.local.yml`
- Modify: `CLAUDE.md`

### Step 1: Update docker-compose.local.yml

Read `docker-compose.local.yml` first. Find the `api` service's `environment:` section. Add the following commented block directly after the last existing env var in that section:

```yaml
      # Semantic retrieval (optional — adds embedding-based reranking):
      # MODEL_EMBEDDING_NAME: text-embedding-3-small
      # RETRIEVE_USE_EMBEDDINGS: "true"
      # Uses MODEL_API_KEY or OPENAI_API_KEY automatically.
```

### Step 2: Update CLAUDE.md

Read `CLAUDE.md` first. Find the "Running locally" section (or the section with the API endpoint info). Add a new subsection at the end of that section:

```markdown
### Enable semantic retrieval (optional)
Add to `.env`:
```
MODEL_EMBEDDING_NAME=text-embedding-3-small
RETRIEVE_USE_EMBEDDINGS=true
```
Uses the same API key as the LLM. Restart the API container after changing. Health endpoint shows `"retrieve":{"useEmbeddings":true}` when active.
```

### Step 3: Run tests to confirm no regressions

```powershell
cd C:\StateCore\StateCore; pnpm --filter @statecore/core test 2>&1 | Select-Object -Last 8
```

Expected: 153 pass, 1 skip.

### Step 4: Commit and push

```powershell
cd C:\StateCore\StateCore
git add docker-compose.local.yml CLAUDE.md
git commit -m "docs: document embedding rerank configuration in docker-compose and CLAUDE.md"
git push origin main
```

---

## Self-Review

**Spec coverage:**
| Spec requirement | Task |
|----------------|------|
| `logger.warn` in catch block | Task 1 Step 3 ✅ |
| Unit test: embedding changes ranking | Task 1 Test 1 ✅ |
| Unit test: fallback on error | Task 1 Test 2 ✅ |
| Unit test: hybrid score formula | Task 1 Test 3 ✅ |
| `it.skip` integration test with real API | Task 2 ✅ |
| `docker-compose.local.yml` commented config | Task 3 ✅ |
| `CLAUDE.md` documentation | Task 3 ✅ |

**Placeholder scan:** None.

**Type consistency:**
- `RetrieveService` constructor signature matches what's in index.ts (verified from source)
- `EmbeddingModel.embed` returns `number[][]` — mock matches
- `result.retrieval.matches[0].embeddingScore` is `number | undefined` — assertions use `toBeDefined()` / `toBeUndefined()` correctly
- `createModelProvider` exported from `./index` — used in integration test correctly
