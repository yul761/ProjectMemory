import { describe, it, expect } from "vitest";
import {
  chunkDeltaCandidates,
  generateDigestStage2,
  normalizeDigestState,
  STAGE2_SECTION_CHAR_BUDGET,
  STAGE2_MAX_CHUNKS,
  type DeltaCandidate,
  type ProjectScope
} from "./digest-control";

function delta(id: string, chars: number): DeltaCandidate {
  return {
    eventId: id,
    reason: "test",
    features: { kind: "profile", importanceScore: 0.8 } as DeltaCandidate["features"],
    // Distinguishable content, so a test can tell which slice a prompt carried.
    event: { id, content: `${id}:${"x".repeat(Math.max(0, chars - id.length - 1))}` } as DeltaCandidate["event"]
  };
}

const SCOPE = { id: "s1", name: "scope", goal: null, stage: "build" } as unknown as ProjectScope;
const STATE = normalizeDigestState(null);

const TEMPLATE = "{{deltaCandidates}}";

function llmReturning(perCall: (n: number) => object) {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    chat: async (messages: { role: string; content: string }[]) => {
      prompts.push(messages[messages.length - 1].content);
      n += 1;
      return JSON.stringify(perCall(n));
    }
  };
}

const okOutput = (facts: { facet: string; value: string }[]) => ({
  goal: "g",
  summary: "a summary",
  changes: [],
  nextSteps: ["next"],
  profileFacts: facts
});

describe("stage 2 sees the whole corpus, not the first prompt-full of it", () => {
  it("splits a corpus larger than the section budget", () => {
    // The defect this covers: `clipSection` cut deltaCandidates to 60k chars and
    // the rest of the corpus never reached the extractor. On LongMemEval that
    // was ~490k chars of sessions against a 60k window — about 12% extracted,
    // and the shortfall was invisible because the verbatim promotion paths were
    // separately copying every event into the fact registry.
    const deltas = Array.from({ length: 8 }, (_, i) => delta(`e${i}`, 40_000));
    const chunks = chunkDeltaCandidates(deltas);
    expect(chunks.length).toBeGreaterThan(1);
    // Well under the pass ceiling, so nothing should be left behind.
    expect(chunks.flat()).toHaveLength(8);
  });

  it("keeps every chunk within the section budget", () => {
    const deltas = Array.from({ length: 30 }, (_, i) => delta(`e${i}`, 9_000));
    for (const chunk of chunkDeltaCandidates(deltas)) {
      const size = chunk.reduce((n, c) => n + c.event.content.length, 0);
      expect(size).toBeLessThanOrEqual(STAGE2_SECTION_CHAR_BUDGET);
    }
  });

  it("gives a single oversized event its own chunk rather than looping", () => {
    const chunks = chunkDeltaCandidates([delta("big", STAGE2_SECTION_CHAR_BUDGET * 3)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it("does not split a corpus that already fits", () => {
    const deltas = [delta("a", 100), delta("b", 100)];
    expect(chunkDeltaCandidates(deltas)).toHaveLength(1);
  });

  it("bounds how many chunks one run will process", () => {
    const deltas = Array.from({ length: 400 }, (_, i) => delta(`e${i}`, 50_000));
    expect(chunkDeltaCandidates(deltas).length).toBeLessThanOrEqual(STAGE2_MAX_CHUNKS);
  });

  it("keeps the most recent events when it has to bound", () => {
    // Events arrive oldest-first. If a bulk import overflows the ceiling, the
    // tail is what a reader is most likely to ask about, and the head is still
    // in the store for the next run.
    const deltas = Array.from({ length: 400 }, (_, i) => delta(`e${i}`, 50_000));
    const kept = chunkDeltaCandidates(deltas).flat().map((d) => d.eventId);
    expect(kept).toContain("e399");
    expect(kept).not.toContain("e0");
  });

  it("extracts from every chunk and unions the facts", async () => {
    const llm = llmReturning((n) => okOutput([{ facet: "goals", value: `fact from pass ${n}` }]));
    const deltas = Array.from({ length: 10 }, (_, i) => delta(`e${i}`, 40_000));

    const out = await generateDigestStage2({
      scope: SCOPE,
      lastDigest: null,
      protectedState: STATE,
      deltaCandidates: deltas,
      documents: [],
      llm,
      systemPrompt: "sys",
      userPromptTemplate: TEMPLATE,
      maxRetries: 0
    });

    expect(llm.prompts.length).toBeGreaterThan(1);
    const values = (out.profileFacts ?? []).map((f) => f.value);
    expect(values).toContain("fact from pass 1");
    expect(values).toContain("fact from pass 2");
  });

  it("makes exactly one call when the corpus fits, so small scopes are unchanged", async () => {
    const llm = llmReturning(() => okOutput([{ facet: "goals", value: "only fact" }]));

    await generateDigestStage2({
      scope: SCOPE,
      lastDigest: null,
      protectedState: STATE,
      deltaCandidates: [delta("a", 200)],
      documents: [],
      llm,
      systemPrompt: "sys",
      userPromptTemplate: TEMPLATE,
      maxRetries: 0
    });

    expect(llm.prompts).toHaveLength(1);
  });

  it("does not repeat the same fact once per chunk", async () => {
    const llm = llmReturning(() => okOutput([{ facet: "goals", value: "the same fact" }]));
    const deltas = Array.from({ length: 10 }, (_, i) => delta(`e${i}`, 40_000));

    const out = await generateDigestStage2({
      scope: SCOPE,
      lastDigest: null,
      protectedState: STATE,
      deltaCandidates: deltas,
      documents: [],
      llm,
      systemPrompt: "sys",
      userPromptTemplate: TEMPLATE,
      maxRetries: 0
    });

    expect((out.profileFacts ?? []).filter((f) => f.value === "the same fact")).toHaveLength(1);
  });

  it("each pass sees a different slice of the corpus", async () => {
    const llm = llmReturning(() => okOutput([]));
    const deltas = [delta("first", 40_000), delta("second", 40_000), delta("third", 40_000)];

    await generateDigestStage2({
      scope: SCOPE,
      lastDigest: null,
      protectedState: STATE,
      deltaCandidates: deltas,
      documents: [],
      llm,
      systemPrompt: "sys",
      userPromptTemplate: TEMPLATE,
      maxRetries: 0
    });

    expect(llm.prompts.length).toBeGreaterThan(1);
    expect(new Set(llm.prompts).size).toBe(llm.prompts.length);
  });
});

describe("a consistency failure must not also lose the facts", () => {
  // Threading each chunk's output forward as the next chunk's lastDigest makes a
  // consistency trip likely — consecutive chunks of one corpus describe similar
  // changes. Every fallback return in the pass dropped profileFacts, so one trip
  // discarded everything that pass had extracted. Observed live: a digest that
  // completed in 344s, reported success, and wrote zero facts.
  //
  // `improve it` is a vague next step under 4 tokens, which fails the check
  // deterministically — no reliance on how the model happens to word things.
  const failingOutput = (facts: { facet: string; value: string }[]) => ({
    goal: "g",
    summary: "a summary",
    changes: ["something changed"],
    nextSteps: ["improve it"],
    profileFacts: facts
  });

  it("keeps the facts from the passes that succeeded when one chunk fails", async () => {
    // The realistic shape: some chunks satisfy the gate, some do not. Before the
    // wrapper caught it, one failing chunk threw and took the whole corpus with
    // it — a regression chunking introduced, since a single pass only ever cost
    // one digest.
    const llm = llmReturning((n) =>
      n === 2
        ? failingOutput([{ facet: "goals", value: `fact ${n}` }])
        : okOutput([{ facet: "goals", value: `fact ${n}` }])
    );
    const deltas = Array.from({ length: 6 }, (_, i) => delta(`e${i}`, 40_000));

    const out = await generateDigestStage2({
      scope: SCOPE,
      lastDigest: null,
      protectedState: STATE,
      deltaCandidates: deltas,
      documents: [],
      llm,
      systemPrompt: "sys",
      userPromptTemplate: TEMPLATE,
      maxRetries: 0
    });

    const values = (out.profileFacts ?? []).map((f) => f.value);
    expect(values).toContain("fact 1");
    expect(values).toContain("fact 3");
  });

  it("keeps the facts when a previous digest exists to fall back to", async () => {
    const llm = llmReturning((n) => failingOutput([{ facet: "goals", value: `fact ${n}` }]));

    const out = await generateDigestStage2({
      scope: SCOPE,
      lastDigest: { summary: "prior", changes: "old change", nextSteps: ["ship it"] } as never,
      protectedState: STATE,
      deltaCandidates: [delta("a", 200)],
      documents: [],
      llm,
      systemPrompt: "sys",
      userPromptTemplate: TEMPLATE,
      maxRetries: 0
    });

    // The digest degrades to the previous summary — that part is intended. The
    // facts are a separate output and did not fail anything.
    expect((out.profileFacts ?? []).map((f) => f.value)).toContain("fact 1");
  });
});
