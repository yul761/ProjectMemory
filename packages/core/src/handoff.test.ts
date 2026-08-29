import { describe, it, expect } from "vitest";
import {
  formatHandoff,
  activeHandoffFromRows,
  handoffRowsToRegistry,
  carryOverConcurrentNotes,
  HANDOFF_FACET,
  type HandoffRow
} from "./handoff";
import { buildFactProvenance } from "./provenance";
import type { DigestState } from "./digest-control";

const row = (partial: Partial<HandoffRow> & Pick<HandoffRow, "id" | "content">): HandoffRow => ({
  createdAt: new Date("2026-08-29T12:00:00Z"),
  supersededBy: null,
  retiredAt: null,
  retiredReason: null,
  ...partial
});

describe("formatHandoff", () => {
  it("composes summary, open questions, and next steps", () => {
    const text = formatHandoff({
      summary: "stopped mid-migration",
      openQuestions: ["flaky or real?"],
      nextSteps: ["wire the controller"]
    });
    expect(text).toContain("stopped mid-migration");
    expect(text).toContain("Open questions:\n- flaky or real?");
    expect(text).toContain("Next steps:\n- wire the controller");
  });
});

describe("activeHandoffFromRows", () => {
  it("returns null for no rows and for all-retired rows", () => {
    expect(activeHandoffFromRows([])).toBeNull();
    expect(activeHandoffFromRows([row({ id: "a", content: "x", retiredAt: new Date() })])).toBeNull();
  });

  it("returns the newest active row with the total stop-point count", () => {
    const rows = [
      row({ id: "a", content: "first", supersededBy: "b", createdAt: new Date("2026-08-01T00:00:00Z") }),
      row({ id: "b", content: "second", createdAt: new Date("2026-08-02T00:00:00Z") })
    ];
    const active = activeHandoffFromRows(rows);
    expect(active).toMatchObject({ id: "b", content: "second", versionCount: 2 });
    expect(active!.addedAt).toBe("2026-08-02T00:00:00.000Z");
  });
});

describe("handoffRowsToRegistry — provenance compatibility", () => {
  it("maps rows so buildFactProvenance walks the stop-point chain", () => {
    const rows = [
      row({ id: "a", content: "first", supersededBy: "b", createdAt: new Date("2026-08-01T00:00:00Z") }),
      row({ id: "b", content: "second", createdAt: new Date("2026-08-02T00:00:00Z") })
    ];
    const registry = handoffRowsToRegistry(rows);
    expect(registry.every((e) => e.facet === HANDOFF_FACET)).toBe(true);
    // A handoff row is its own evidence — no fabricated foreign ids.
    expect(registry[0].evidenceId).toBe("a");

    const state: DigestState = { stableFacts: { decisions: [] }, workingNotes: {}, todos: [], factRegistry: registry, profile: {} };
    const provenance = buildFactProvenance(state, "b");
    expect(provenance?.chain.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("carryOverConcurrentNotes", () => {
  const baseState = (): DigestState => ({
    stableFacts: { decisions: [] },
    workingNotes: {},
    todos: [],
    factRegistry: [],
    profile: {}
  });

  const noteEntry = (id: string, content: string) => ({
    id,
    content,
    type: "profile" as const,
    confidence: 0.9,
    addedAt: "2026-08-29T12:00:00.000Z",
    evidenceId: `${id}-ev`,
    evidenceType: "event" as const,
    facet: "notes"
  });

  it("carries a note written concurrently into the pipeline's state", () => {
    const pipeline = baseState();
    const latest = baseState();
    latest.factRegistry!.push(noteEntry("n1", "written mid-digest"));
    (latest.profile as Record<string, string[]>).notes = ["written mid-digest"];

    const carried = carryOverConcurrentNotes(pipeline, latest);

    expect(carried).toBe(1);
    expect(pipeline.factRegistry!.some((e) => e.id === "n1")).toBe(true);
    expect((pipeline.profile as Record<string, string[]>).notes).toContain("written mid-digest");
  });

  it("does not duplicate entries the pipeline already has, and ignores non-note facets", () => {
    const pipeline = baseState();
    pipeline.factRegistry!.push(noteEntry("n1", "already there"));
    const latest = baseState();
    latest.factRegistry!.push(noteEntry("n1", "already there"));
    latest.factRegistry!.push({ ...noteEntry("g1", "a goal"), facet: "goals" });

    const carried = carryOverConcurrentNotes(pipeline, latest);

    expect(carried).toBe(0);
    expect(pipeline.factRegistry!).toHaveLength(1);
  });
});
