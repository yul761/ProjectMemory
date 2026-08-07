import { describe, it, expect } from "vitest";
import {
  applyProfileFactsFromDigest,
  MAX_FACT_CHARS,
  isFactSized,
  type DigestState
} from "./digest-control";
import type { DropRecord } from "./drop-log";

function emptyState(): DigestState {
  return { stableFacts: {}, factRegistry: [] } as unknown as DigestState;
}

const NOW = () => "2026-08-07T00:00:00.000Z";

// A transcript, not a statement. Shaped like the events LongMemEval ingests and
// like any document a caller might send.
const SESSION = `[2023/05/27 (Sat) 08:29]\nuser: ${"I have been thinking about my travel habits. ".repeat(40)}`;

describe("a fact is a statement, not a document", () => {
  it("keeps a whole session out of the fact registry", () => {
    // The defect this covers: three paths promoted `event.content` verbatim into
    // the fact registry with no bound on its size. Ingesting sessions or
    // documents turned the fact layer into a copy of the corpus — 87% of entries
    // over 1000 tokens, median 2691 — which then crowded the genuinely extracted
    // facts (11-27 tokens) out of every context budget at a ratio of about 100:1.
    const state = emptyState();
    const dropLog: DropRecord[] = [];

    applyProfileFactsFromDigest(
      state,
      [{ facet: "goals", value: SESSION }],
      [],
      null,
      () => "id-1",
      NOW,
      dropLog
    );

    expect(state.factRegistry).toHaveLength(0);
    expect(dropLog.map((d) => d.reason)).toContain("fact_too_long");
  });

  it("records the drop with the length, so the audit trail says what was refused", () => {
    const state = emptyState();
    const dropLog: DropRecord[] = [];

    applyProfileFactsFromDigest(
      state,
      [{ facet: "goals", value: SESSION }],
      [],
      null,
      () => "id-1",
      NOW,
      dropLog
    );

    const drop = dropLog.find((d) => d.reason === "fact_too_long");
    expect(drop?.detail).toMatchObject({ facet: "goals", limit: MAX_FACT_CHARS });
    expect(drop?.detail.length).toBe(SESSION.trim().length);
  });

  it("still accepts a fact of the size extraction actually produces", () => {
    // Real stage-2 output, from the benchmark corpus.
    const state = emptyState();
    const dropLog: DropRecord[] = [];

    applyProfileFactsFromDigest(
      state,
      [{ facet: "relationships", value: "Newborn nephew Ethan (born ~3 weeks ago), birthweight 7 pounds" }],
      [],
      { id: "evt-1", sourceType: "event" },
      () => "id-2",
      NOW,
      dropLog
    );

    expect(dropLog.filter((d) => d.reason === "fact_too_long")).toHaveLength(0);
    expect(state.factRegistry?.[0]?.content).toContain("Ethan");
  });

  it("refuses the same session even when evidence is present", () => {
    // The registry write is guarded, not just the profile write: with evidence
    // attached the promotion path is the one that used to run.
    const state = emptyState();
    const dropLog: DropRecord[] = [];

    applyProfileFactsFromDigest(
      state,
      [{ facet: "relationships", value: SESSION }],
      [],
      { id: "evt-1", sourceType: "event" },
      () => "id-3",
      NOW,
      dropLog
    );

    expect(state.factRegistry).toHaveLength(0);
    expect(state.profile?.relationships ?? []).toHaveLength(0);
  });

  it("bounds on the fact, not on the event it came from", () => {
    // A long conversation that yields a short fact is the normal case, and must
    // not be penalised: the guard sits on what gets written, not on the source.
    expect(isFactSized("Weekday routine: wake 7:00, work 9:00-17:00; aims 7-8h sleep")).toBe(true);
    expect(isFactSized(SESSION)).toBe(false);
  });

  it("treats the limit as inclusive", () => {
    expect(isFactSized("x".repeat(MAX_FACT_CHARS))).toBe(true);
    expect(isFactSized("x".repeat(MAX_FACT_CHARS + 1))).toBe(false);
  });

  it("ignores surrounding whitespace when measuring", () => {
    expect(isFactSized("  " + "x".repeat(MAX_FACT_CHARS) + "  ")).toBe(true);
  });
});
