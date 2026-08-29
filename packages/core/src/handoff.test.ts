import { describe, it, expect } from "vitest";
import { setHandoffFact, getActiveHandoff, HANDOFF_FACET } from "./handoff";
import type { DigestState } from "./digest-control";

function emptyState(): DigestState {
  return { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: [], profile: {} };
}

let counter = 0;
const makeId = () => `id-${++counter}`;
const makeNow = () => "2026-08-29T12:00:00.000Z";

describe("setHandoffFact", () => {
  it("stores a handoff as a registry fact under the handoff facet", () => {
    const state = emptyState();
    const result = setHandoffFact(
      state,
      { summary: "Migrating retrieve to RRF; stage 2 half done", openQuestions: ["keep the old scorer?"], nextSteps: ["wire the api controller"] },
      makeId,
      makeNow
    );

    expect(result.changed).toBe(true);
    const entry = state.factRegistry!.find((f) => f.facet === HANDOFF_FACET);
    expect(entry).toBeDefined();
    expect(entry!.content).toContain("Migrating retrieve to RRF");
    expect(entry!.content).toContain("keep the old scorer?");
    expect(entry!.content).toContain("wire the api controller");
  });

  it("supersedes the previous handoff instead of accumulating", () => {
    const state = emptyState();
    setHandoffFact(state, { summary: "first stop point" }, makeId, makeNow);
    const second = setHandoffFact(state, { summary: "second stop point" }, makeId, makeNow);

    expect(second.changed).toBe(true);
    const entries = state.factRegistry!.filter((f) => f.facet === HANDOFF_FACET);
    expect(entries).toHaveLength(2);
    const [first, latest] = entries;
    expect(first.supersededBy).toBe(latest.id);
    expect(latest.supersededBy).toBeUndefined();
    expect(second.changed && second.supersededId).toBe(first.id);
  });

  it("rejects an empty summary", () => {
    const state = emptyState();
    expect(setHandoffFact(state, { summary: "   " }, makeId, makeNow)).toEqual({ changed: false });
    expect(state.factRegistry).toHaveLength(0);
  });
});

describe("getActiveHandoff", () => {
  it("returns null when no handoff was ever set", () => {
    expect(getActiveHandoff(emptyState())).toBeNull();
  });

  it("returns the latest handoff with its version count", () => {
    const state = emptyState();
    setHandoffFact(state, { summary: "first" }, makeId, makeNow);
    setHandoffFact(state, { summary: "second" }, makeId, makeNow);

    const active = getActiveHandoff(state);
    expect(active).not.toBeNull();
    expect(active!.content).toContain("second");
    expect(active!.addedAt).toBe("2026-08-29T12:00:00.000Z");
    expect(active!.versionCount).toBe(2);
  });

  it("ignores a retired handoff", () => {
    const state = emptyState();
    setHandoffFact(state, { summary: "only one" }, makeId, makeNow);
    const entry = state.factRegistry!.find((f) => f.facet === HANDOFF_FACET)!;
    entry.retiredAt = makeNow();
    entry.retiredReason = "user_forget";

    expect(getActiveHandoff(state)).toBeNull();
  });
});
