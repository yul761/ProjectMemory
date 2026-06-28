# Conversational Fact Extraction for the Memory Screen

- **Date:** 2026-06-28
- **Status:** Proposed (pre-implementation)
- **Repo:** `StateCore` (engine) only. Cloud is `ALL /v1/*` passthrough (no change); `assistant-backend` already reads `/v1/memory/facts` (no change).
- **Deploy:** Droplet 1 (engine api + **worker** — digests run in the worker).

## 0. Problem

The Remi Memory screen (`GET /v1/memory/facts` → grouped Schedule / People / Preferences / Projects) is always empty for conversational use. Root cause, traced end to end:

- `flattenScopeFacts` (`packages/core/src/memory-facts.ts`) builds the screen from `state.profile` facets mapped by `FACET_TO_GROUP`: `followUps→Schedule`, `relationships→People`, `style→Preferences`, `goals→Projects`, `ongoing→Projects`. **`identity` is intentionally never shown.**
- But the digest extraction is hard-wired to produce **only `identity`, and only from document bodies (resumes/bios)**:
  - `digestStage2SystemPrompt` / `digestStage2UserPrompt` (`packages/prompts/src`): *"profileFacts: Extract ONLY from document bodies … Use facet 'identity' … Omit … if no documents contain personal profile data."*
  - `applyProfileFactsFromDigest` (`packages/core/src/digest-control.ts`): bails unless an `identity` fact is present (the `if (!profileFacts.some(pf => pf.facet === "identity")) return;` guard) and `continue`s on every non-identity facet (`// Stage 1: only identity`).
- Remi writes **conversational stream events** (`User: …\nAssistant: …`), never documents. So extraction yields nothing, and even if it did (`identity`) the screen hides it. The two halves never meet → empty screen.

This is the "facts vs events" gap flagged in the cross-repo handoff doc §3.

## 1. Goal

Make the digest **extract the displayable facets from conversation** so the Memory screen populates. Per the locked decision, extraction is **aggressive**: when the user reveals a preference, goal, person, commitment, or ongoing thing, capture it (noise is acceptable; the existing `forget` removes unwanted entries).

## 2. Approach

Extend the existing digest `profileFacts` pipeline (reuse its dedup, per-facet caps, factRegistry, and forget). No new pipeline, no new LLM pass.

### 2.1 Extraction prompt (`packages/prompts/src/index.ts`)

Rewrite the `profileFacts` portion of `digestStage2SystemPrompt` and `digestStage2UserPrompt` to extract these facets from the **Delta candidates (conversation)** as well as documents:

| facet | meaning | examples |
|---|---|---|
| `style` | preferences, tastes, communication style | "喜欢 teal 色", "偏好简洁回答", "口味偏辣" |
| `goals` | things the user wants to achieve | "想减肥", "7 月上线 Remi" |
| `relationships` | important people in the user's life | "妈妈", "同事 Alex", "供应商老王" |
| `followUps` | commitments / things to remember or do | "周四 2 点看牙医", "给供应商打电话问 Q3" |
| `ongoing` | projects / things in progress | "在做盲盒生意", "在学西班牙语" |
| `identity` | durable personal facts (kept; screen hides it) | "工作经历: 字节跳动 后端 2019-2022" |

Rules to keep in the prompt: each value is a **self-contained fact line**; extract aggressively whenever the user reveals such info (from conversation, not only documents); **do not invent** facts absent from the evidence; output stays `{facet, value}[]`. The classifier flag `DIGEST_USE_LLM_CLASSIFIER` is already enabled (separate improvement; it sharpens selection, not extraction).

### 2.2 Apply logic (`applyProfileFactsFromDigest`, `digest-control.ts`)

Generalize from identity-only to all displayable facets:

- Remove the `identity`-only early-return guard and the per-fact `continue` that skips non-identity facets.
- Accept facets in the allowed set: `identity, style, goals, relationships, followUps, ongoing` (ignore unknown facets).
- For each fact, store into `state.profile[facet]` with the **existing** `sameFactCjkAware` dedup and the **existing per-facet caps** (`identity 15, relationships 10, ongoing 8, goals 8, followUps 10, style 6` — already enforced in the state-shape clamp at digest-control.ts ~308-313).
- **Evidence:** use a document ref when the fact came from a document (current behavior, authority 0.85); otherwise attach a **stream-event ref** from the digest window with lower authority (0.6) and `promoteToFactRegistry(..., facet, ...)`. This keeps `forget` working (suppress-by-evidence) and gives the screen a `createdAt`.
- Identity retains its current document-authority behavior; the change is purely additive for the other facets.

## 3. Testing (vitest, `apps/api` + `packages/core`)

- `applyProfileFactsFromDigest`: given `profileFacts` with `style`/`goals`/`relationships`/`followUps`/`ongoing` values → each lands in `state.profile[facet]`; dedup collapses near-duplicates; per-facet caps respected; unknown facet ignored; the existing identity tests still pass.
- End-to-end (`digest-control` integration): a delta candidate stating a preference → after `runDigestControlPipeline`, `state.profile.style` contains it → `flattenScopeFacts` returns it under `Preferences`; a goal → `Projects`; a person → `People`.
- Prompt snapshot/contract tests (if any) updated for the new prompt text.
- Real verification (post-deploy): trigger a rebuild for the live scope and confirm `GET /v1/memory/facts` returns non-empty groups.

## 4. Deploy & backfill

- Deploy Droplet 1: rebuild **engine api + worker** (digests run in the worker), `ssh statecore`, both compose files.
- **Backfill:** existing events were already digested into `volatileContext` and won't re-extract on an incremental digest. After deploy, trigger `POST /v1/memory/digest/rebuild` for the live scope so its existing conversation is re-processed from scratch into facts.

## 5. Out of scope

A redesigned Memory data model; per-fact confidence UI; sensitive-topic redaction (aggressive extraction may capture health/personal goals the user shared — removal is via `forget`); changing `FACET_TO_GROUP` or the four display groups; document-ingestion changes; any cloud or assistant-backend change.
