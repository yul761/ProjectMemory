import { describe, expect, it } from "vitest";
import {
  consistencyCheck,
  detectDeltas,
  generateDigestStage2,
  getActiveFactRegistry,
  normalizeDigestState,
  protectedStateMerge,
  runDigestControlPipeline,
  selectEventsForDigest,
  type DigestState,
  type FactRegistryEntry,
  type SelectedEvent
} from "./digest-control";
import type { MemoryEvent } from "./index";
import { compileStateLayerView, formatStateLayerView } from "./working-memory.compiler";

function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, "id" | "scopeId" | "userId" | "content" | "type">): MemoryEvent {
  return {
    source: "api",
    createdAt: new Date(),
    ...partial
  };
}

describe("selectEventsForDigest", () => {
  it("dedups near-identical stream events and includes latest docs within budget", () => {
    const events: MemoryEvent[] = [
      event({ id: "s1", scopeId: "sc", userId: "u", type: "stream", content: "We decide to ship API v1", createdAt: new Date("2026-02-01T10:00:00Z") }),
      event({ id: "s2", scopeId: "sc", userId: "u", type: "stream", content: "We decide to ship API v1!", createdAt: new Date("2026-02-01T09:59:00Z") }),
      event({ id: "d1", scopeId: "sc", userId: "u", type: "document", key: "note:plan", content: "goal: launch beta", createdAt: new Date("2026-02-01T09:58:00Z") }),
      event({ id: "d2", scopeId: "sc", userId: "u", type: "document", key: "note:plan", content: "goal: launch beta soon", createdAt: new Date("2026-02-01T10:01:00Z") })
    ];

    const result = selectEventsForDigest({
      recentEvents: events,
      lastDigest: null,
      eventBudgetTotal: 3,
      eventBudgetDocs: 1,
      eventBudgetStream: 2
    });

    const ids = result.selectedEvents.map((item) => item.event.id);
    expect(ids).toContain("d2");
    expect(ids).not.toContain("d1");
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
  });
});

describe("detectDeltas", () => {
  it("keeps decisions even when novelty is low", () => {
    const selected: SelectedEvent[] = [
      {
        event: event({ id: "e1", scopeId: "sc", userId: "u", type: "stream", content: "we decide to keep postgres" }),
        features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0 }
      },
      {
        event: event({ id: "e2", scopeId: "sc", userId: "u", type: "stream", content: "daily status update" }),
        features: { kind: "status", importanceScore: 0.4, noveltyScore: 0 }
      }
    ];

    const deltas = detectDeltas({
      lastDigestText: "we decide to keep postgres; daily status update",
      selectedEvents: selected,
      noveltyThreshold: 0.5
    });

    expect(deltas.map((item) => item.eventId)).toContain("e1");
  });

  it("prioritizes durable stream facts ahead of contextual stream budget", () => {
    const baseTime = new Date("2026-03-19T00:00:00.000Z");
    const selected = selectEventsForDigest({
      recentEvents: [
        event({
          id: "doc-goal",
          scopeId: "sc",
          userId: "u",
          type: "document",
          key: "doc:goal",
          content: "goal: maximize digest consistency"
        }),
        ...Array.from({ length: 6 }, (_, index) =>
          event({
            id: `evt-decision-${index}`,
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: `We decide to prioritize consistency batch ${index}`,
            createdAt: new Date(baseTime.getTime() + index * 1000)
          })
        ),
        event({
          id: "evt-note",
          scopeId: "sc",
          userId: "u",
          type: "stream",
          content: "Status update: processed benchmark queue",
          createdAt: new Date(baseTime.getTime() + 10_000)
        })
      ],
      eventBudgetTotal: 8,
      eventBudgetDocs: 1,
      eventBudgetStream: 2
    });

    const contents = selected.selectedEvents.map((item) => item.event.content);
    expect(contents).toContain("We decide to prioritize consistency batch 0");
    expect(contents).toContain("We decide to prioritize consistency batch 5");
    expect(contents.filter((value) => value.startsWith("We decide to prioritize consistency batch"))).toHaveLength(6);
  });

  it("does not emit document events as delta candidates because documents are merged separately", () => {
    const selected: SelectedEvent[] = [
      {
        event: event({
          id: "doc-1",
          scopeId: "sc",
          userId: "u",
          type: "document",
          key: "doc:constraints",
          content: "constraint: self-hosted first"
        }),
        features: { kind: "constraint", importanceScore: 0.9, noveltyScore: 0 }
      },
      {
        event: event({ id: "e1", scopeId: "sc", userId: "u", type: "stream", content: "We decide to keep postgres" }),
        features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0 }
      }
    ];

    const deltas = detectDeltas({
      lastDigestText: "",
      selectedEvents: selected,
      noveltyThreshold: 0.5
    });

    expect(deltas.map((item) => item.eventId)).toEqual(["e1"]);
  });

  it("does not emit assistant reply noise even when novelty is high", () => {
    const selected: SelectedEvent[] = [
      {
        event: event({
          id: "assistant-1",
          scopeId: "sc",
          userId: "u",
          type: "stream",
          content: "Assistant reply: We decided to prioritize ingestion throughput batch 50."
        }),
        features: { kind: "noise", importanceScore: 0.05, noveltyScore: 0 }
      },
      {
        event: event({
          id: "risk-1",
          scopeId: "sc",
          userId: "u",
          type: "stream",
          content: "Blocked by queue visibility timeout around item 51"
        }),
        features: { kind: "note", importanceScore: 0.6, noveltyScore: 0 }
      }
    ];

    const deltas = detectDeltas({
      lastDigestText: "",
      selectedEvents: selected,
      noveltyThreshold: 0.1
    });

    expect(deltas.map((item) => item.eventId)).toEqual(["risk-1"]);
  });
});

describe("protectedStateMerge", () => {
  it("does not overwrite goal without explicit goal marker", () => {
    const prevState: DigestState = {
      stableFacts: { goal: "ship alpha", constraints: ["no paid infra"], decisions: ["use postgres"] },
      workingNotes: {},
      todos: [],
      volatileContext: [],
      evidenceRefs: []
    };

    const merged = protectedStateMerge({
      prevState,
      documents: [event({ id: "doc1", scopeId: "sc", userId: "u", type: "document", key: "note:1", content: "regular update text" })],
      deltaCandidates: []
    });

    expect(merged.stableFacts.goal).toBe("ship alpha");
    expect(merged.stableFacts.decisions).toContain("use postgres");
  });

  it("captures volatile context and evidence references", () => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [
        event({ id: "doc1", scopeId: "sc", userId: "u", type: "document", key: "doc:goal", content: "goal: ship alpha" })
      ],
      deltaCandidates: [
        {
          eventId: "e1",
          reason: "novel_event",
          features: { kind: "status", importanceScore: 0.5, noveltyScore: 0.7 },
          event: event({ id: "e1", scopeId: "sc", userId: "u", type: "stream", content: "Status update: queue is stable" })
        },
        {
          eventId: "e2",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.4, noveltyScore: 0.8 },
          event: event({ id: "e2", scopeId: "sc", userId: "u", type: "stream", content: "Note: keep digest reports small" })
        }
      ]
    });

    expect(merged.volatileContext).toContain("Status update: queue is stable");
    expect(merged.volatileContext).toContain("Note: keep digest reports small");
    expect(merged.evidenceRefs).toContainEqual(expect.objectContaining({
      id: "doc1",
      sourceType: "document",
      key: "doc:goal"
    }));
    expect(merged.evidenceRefs).toContainEqual(expect.objectContaining({
      id: "e1",
      sourceType: "event",
      kind: "status"
    }));
    expect(merged.evidenceRefs).toContainEqual(expect.objectContaining({
      id: "e2",
      sourceType: "event",
      kind: "note"
    }));
    expect(merged.provenance?.goal).toContainEqual(expect.objectContaining({
      id: "doc1",
      sourceType: "document",
      key: "doc:goal"
    }));
    expect(merged.provenance?.volatileContext).toContainEqual(expect.objectContaining({
      value: "Status update: queue is stable"
    }));
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "goal",
          value: "ship alpha"
        }),
        expect.objectContaining({
          field: "volatileContext",
          value: "Note: keep digest reports small"
        })
      ])
    );
  });

  it("promotes goal lines from stream deltas into stable goal instead of volatile context", () => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [
        {
          eventId: "goal-1",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.55, noveltyScore: 0.8 },
          event: event({
            id: "goal-1",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "goal: ship structured persistence for runtime turns"
          })
        }
      ]
    });

    expect(merged.stableFacts.goal).toBe("ship structured persistence for runtime turns");
    expect(merged.volatileContext ?? []).not.toContain("goal: ship structured persistence for runtime turns");
    expect(merged.provenance?.goal).toContainEqual(expect.objectContaining({
      id: "goal-1",
      sourceType: "event",
      kind: "note"
    }));
  });

  it("promotes natural-language goal turns from stream deltas into stable goal instead of volatile context", () => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [
        {
          eventId: "goal-natural-1",
          reason: "novel_event",
          features: { kind: "note", importanceScore: 0.55, noveltyScore: 0.8 },
          event: event({
            id: "goal-natural-1",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "I want to learn to get good dressing style"
          })
        }
      ]
    });

    expect(merged.stableFacts.goal).toBe("learn to get good dressing style");
    expect(merged.volatileContext ?? []).not.toContain("I want to learn to get good dressing style");
    expect(merged.provenance?.goal).toContainEqual(expect.objectContaining({
      id: "goal-natural-1",
      sourceType: "event",
      kind: "note"
    }));
  });

  it("removes conflicting older decisions when newer layer-separation decisions arrive", () => {
    const merged = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [
        {
          eventId: "decision-old",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "decision-old",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We decide to merge every memory layer into one prompt path",
            createdAt: new Date("2026-03-26T00:00:00Z")
          })
        },
        {
          eventId: "decision-new",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "decision-new",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We decide to keep the assistant runtime as a product boundary instead of merging layers into one prompt path",
            createdAt: new Date("2026-03-26T00:00:01Z")
          })
        }
      ]
    });

    expect(merged.stableFacts.decisions).toContain("We decide to keep the assistant runtime as a product boundary instead of merging layers into one prompt path");
    expect(merged.stableFacts.decisions).not.toContain("We decide to merge every memory layer into one prompt path");
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "decisions", action: "remove", value: "We decide to merge every memory layer into one prompt path" }),
        expect.objectContaining({ field: "decisions", action: "add", value: "We decide to keep the assistant runtime as a product boundary instead of merging layers into one prompt path" })
      ])
    );
  });

  it("reaffirms semantically equivalent goals without replacing provenance", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: { goal: "ship a self hosted memory runtime", constraints: [], decisions: [] },
        workingNotes: {},
        todos: [],
        provenance: {
          goal: [{ id: "doc-old", sourceType: "document", key: "doc:goal" }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [
        event({ id: "doc-new", scopeId: "sc", userId: "u", type: "document", key: "doc:goal", content: "goal: ship a self-hosted memory runtime" })
      ],
      deltaCandidates: []
    });

    expect(merged.stableFacts.goal).toBe("ship a self hosted memory runtime");
    expect(merged.provenance?.goal).toEqual([
      { id: "doc-old", sourceType: "document", key: "doc:goal" },
      { id: "doc-new", sourceType: "document", key: "doc:goal" }
    ]);
    expect(merged.recentChanges).toContainEqual(
      expect.objectContaining({
        field: "goal",
        action: "reaffirm",
        value: "ship a self hosted memory runtime"
      })
    );
  });

  it("records goal replacement as remove plus set and resets goal provenance", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: { goal: "ship alpha", constraints: [], decisions: [] },
        workingNotes: {},
        todos: [],
        provenance: {
          goal: [{ id: "doc-old", sourceType: "document", key: "doc:goal" }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [
        event({ id: "doc-new", scopeId: "sc", userId: "u", type: "document", key: "doc:goal", content: "goal: ship beta runtime" })
      ],
      deltaCandidates: []
    });

    expect(merged.stableFacts.goal).toBe("ship beta runtime");
    expect(merged.provenance?.goal).toEqual([
      { id: "doc-new", sourceType: "document", key: "doc:goal" }
    ]);
    expect(merged.confidence?.goal).toBe(1);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "goal",
          action: "remove",
          value: "ship alpha"
        }),
        expect.objectContaining({
          field: "goal",
          action: "set",
          value: "ship beta runtime"
        })
      ])
    );
  });

  it("supersedes document-backed constraints and todos when the same document key changes", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: ["self-hosted first", "keep api stable"],
          decisions: []
        },
        workingNotes: {},
        todos: ["ship runtime", "publish benchmark report"],
        provenance: {
          constraints: [
            { value: "self-hosted first", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] },
            { value: "keep api stable", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] }
          ],
          todos: [
            { value: "ship runtime", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] },
            { value: "publish benchmark report", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [
        event({
          id: "doc-new",
          scopeId: "sc",
          userId: "u",
          type: "document",
          key: "doc:plan",
          content: "constraint: self-hosted first\ntodo: ship runtime"
        })
      ],
      deltaCandidates: []
    });

    expect(merged.stableFacts.constraints).toEqual(["self-hosted first"]);
    expect(merged.todos).toEqual(["ship runtime"]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "constraints", action: "remove", value: "keep api stable" }),
        expect.objectContaining({ field: "constraints", action: "reaffirm", value: "self-hosted first" }),
        expect.objectContaining({ field: "todos", action: "remove", value: "publish benchmark report" }),
        expect.objectContaining({ field: "todos", action: "reaffirm", value: "ship runtime" })
      ])
    );
  });

  it("supersedes document-backed decisions when the same document key changes", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: ["use postgres", "ship cli first"]
        },
        workingNotes: {},
        todos: [],
        provenance: {
          decisions: [
            { value: "use postgres", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] },
            { value: "ship cli first", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [
        event({
          id: "doc-new",
          scopeId: "sc",
          userId: "u",
          type: "document",
          key: "doc:plan",
          content: "decision: use postgres"
        })
      ],
      deltaCandidates: []
    });

    expect(merged.stableFacts.decisions).toEqual(["use postgres"]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "decisions", action: "remove", value: "ship cli first" }),
        expect.objectContaining({ field: "decisions", action: "reaffirm", value: "use postgres" })
      ])
    );
  });

  it("does not remove constraints or todos backed by non-document evidence when a document changes", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: ["self-hosted first", "keep api stable"],
          decisions: []
        },
        workingNotes: {},
        todos: ["ship runtime", "publish benchmark report"],
        provenance: {
          constraints: [
            { value: "self-hosted first", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] },
            { value: "keep api stable", refs: [{ id: "evt-1", sourceType: "event", kind: "constraint" }] }
          ],
          todos: [
            { value: "ship runtime", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] },
            { value: "publish benchmark report", refs: [{ id: "evt-2", sourceType: "event", kind: "todo" }] }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [
        event({
          id: "doc-new",
          scopeId: "sc",
          userId: "u",
          type: "document",
          key: "doc:plan",
          content: "constraint: self-hosted first\ntodo: ship runtime"
        })
      ],
      deltaCandidates: []
    });

    expect(merged.stableFacts.constraints).toEqual(expect.arrayContaining(["self-hosted first", "keep api stable"]));
    expect(merged.todos).toEqual(expect.arrayContaining(["ship runtime", "publish benchmark report"]));
    expect(merged.recentChanges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "constraints", action: "remove", value: "keep api stable" }),
        expect.objectContaining({ field: "todos", action: "remove", value: "publish benchmark report" })
      ])
    );
  });

  it("removes the most similar decision instead of blindly removing the last one", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: ["use postgres for storage", "ship cli first"]
        },
        workingNotes: {},
        todos: [],
        provenance: {
          decisions: [
            { value: "use postgres for storage", refs: [{ id: "evt-old", sourceType: "event", kind: "decision" }] },
            { value: "ship cli first", refs: [{ id: "evt-old-2", sourceType: "event", kind: "decision" }] }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-revoke",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-revoke",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Revoke use postgres for storage"
          })
        }
      ]
    });

    expect(merged.stableFacts.decisions).toEqual(["ship cli first"]);
    expect(merged.recentChanges).toContainEqual(
      expect.objectContaining({ field: "decisions", action: "remove", value: "use postgres for storage" })
    );
  });

  it("keeps similarly worded numbered decisions as distinct durable facts", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: ["We decide to prioritize consistency batch 0"]
        },
        workingNotes: {},
        todos: [],
        provenance: {
          decisions: [
            {
              value: "We decide to prioritize consistency batch 0",
              refs: [{ id: "evt-old", sourceType: "event", kind: "decision" }]
            }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-new",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-new",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We decide to prioritize consistency batch 3"
          })
        }
      ]
    });

    expect(merged.stableFacts.decisions).toEqual([
      "We decide to prioritize consistency batch 0",
      "We decide to prioritize consistency batch 3"
    ]);
    expect(merged.recentChanges).toContainEqual(
      expect.objectContaining({ field: "decisions", action: "add", value: "We decide to prioritize consistency batch 3" })
    );
  });

  it("keeps similarly worded numbered todos as distinct durable facts", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {},
        todos: ["TODO: validate consistency metric 1"],
        provenance: {
          todos: [
            {
              value: "TODO: validate consistency metric 1",
              refs: [{ id: "evt-old", sourceType: "event", kind: "todo" }]
            }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-new",
          reason: "stable_fact_signal",
          features: { kind: "todo", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-new",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "TODO: validate consistency metric 8"
          })
        }
      ]
    });

    expect(merged.todos).toEqual([
      "TODO: validate consistency metric 1",
      "TODO: validate consistency metric 8"
    ]);
    expect(merged.recentChanges).toContainEqual(
      expect.objectContaining({ field: "todos", action: "add", value: "TODO: validate consistency metric 8" })
    );
  });

  it("reaffirms semantically equivalent constraints and todos from stream events", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: ["self hosted only"],
          decisions: []
        },
        workingNotes: {},
        todos: ["ship runtime docs"],
        provenance: {
          constraints: [{ value: "self hosted only", refs: [{ id: "evt-old", sourceType: "event", kind: "constraint" }] }],
          todos: [{ value: "ship runtime docs", refs: [{ id: "evt-old-2", sourceType: "event", kind: "todo" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-constraint",
          reason: "stable_fact_signal",
          features: { kind: "constraint", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-constraint",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "self-hosted only"
          })
        },
        {
          eventId: "evt-todo",
          reason: "stable_fact_signal",
          features: { kind: "todo", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-todo",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "ship runtime documentation"
          })
        }
      ]
    });

    expect(merged.stableFacts.constraints).toEqual(["self hosted only"]);
    expect(merged.todos).toEqual(["ship runtime docs"]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "constraints", action: "reaffirm", value: "self hosted only" }),
        expect.objectContaining({ field: "todos", action: "reaffirm", value: "ship runtime docs" })
      ])
    );
  });

  it("normalizes structured constraint prefixes from stream events", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {},
        todos: [],
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-constraint-prefixed",
          reason: "stable_fact_signal",
          features: { kind: "constraint", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-constraint-prefixed",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "constraint: keep fast path under 2 seconds"
          })
        },
        {
          eventId: "evt-todo-prefixed",
          reason: "stable_fact_signal",
          features: { kind: "todo", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-todo-prefixed",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "TODO: add a visible fast-layer smoke test"
          })
        }
      ]
    });

    expect(merged.stableFacts.constraints).toEqual(["keep fast path under 2 seconds"]);
    expect(merged.todos).toEqual(["TODO: add a visible fast-layer smoke test"]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "constraints", action: "add", value: "keep fast path under 2 seconds" }),
        expect.objectContaining({ field: "todos", action: "add", value: "TODO: add a visible fast-layer smoke test" })
      ])
    );
  });

  it("reaffirms semantically equivalent working-note entries from stream events", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          openQuestions: ["should we support ollama first"],
          risks: ["blocked by provider setup"]
        },
        todos: [],
        volatileContext: ["Status update queue stable"],
        provenance: {
          openQuestions: [{ value: "should we support ollama first", refs: [{ id: "evt-q-old", sourceType: "event", kind: "question" }] }],
          risks: [{ value: "blocked by provider setup", refs: [{ id: "evt-r-old", sourceType: "event", kind: "status" }] }],
          volatileContext: [{ value: "Status update queue stable", refs: [{ id: "evt-v-old", sourceType: "event", kind: "status" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-question",
          reason: "working_note_signal",
          features: { kind: "question", importanceScore: 0.7, noveltyScore: 0.9 },
          event: event({
            id: "evt-question",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Should we support Ollama first?"
          })
        },
        {
          eventId: "evt-status",
          reason: "working_note_signal",
          features: { kind: "status", importanceScore: 0.6, noveltyScore: 0.9 },
          event: event({
            id: "evt-status",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "status update: queue is stable"
          })
        },
        {
          eventId: "evt-risk",
          reason: "working_note_signal",
          features: { kind: "status", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-risk",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "blocker: provider setup"
          })
        }
      ]
    });

    expect(merged.workingNotes.openQuestions).toEqual(["should we support ollama first"]);
    expect(merged.volatileContext).toEqual(
      expect.arrayContaining(["Status update queue stable", "blocker: provider setup"])
    );
    expect(merged.volatileContext?.filter((item) => item === "Status update queue stable")).toHaveLength(1);
    expect(merged.workingNotes.risks).toEqual(["blocked by provider setup"]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "openQuestions", action: "reaffirm", value: "should we support ollama first" }),
        expect.objectContaining({ field: "volatileContext", action: "reaffirm", value: "Status update queue stable" }),
        expect.objectContaining({ field: "risks", action: "reaffirm", value: "blocked by provider setup" })
      ])
    );
  });

  it("resolves matching open questions from decisions", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          openQuestions: ["should we support ollama first"]
        },
        todos: [],
        volatileContext: [],
        provenance: {
          openQuestions: [{ value: "should we support ollama first", refs: [{ id: "evt-q-old", sourceType: "event", kind: "question" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-decision",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-decision",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We will support Ollama first"
          })
        }
      ]
    });

    expect(merged.workingNotes.openQuestions).toEqual([]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "openQuestions", action: "remove", value: "should we support ollama first" })
      ])
    );
  });

  it("resolves matching risks from status updates", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          risks: ["blocked by provider setup"]
        },
        todos: [],
        volatileContext: [],
        provenance: {
          risks: [{ value: "blocked by provider setup", refs: [{ id: "evt-r-old", sourceType: "event", kind: "status" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-status",
          reason: "working_note_signal",
          features: { kind: "status", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-status",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "unblocked provider setup"
          })
        }
      ]
    });

    expect(merged.workingNotes.risks).toEqual([]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "risks", action: "remove", value: "blocked by provider setup" })
      ])
    );
  });

  it("resolves working notes even when decisions and statuses include conversational prefixes", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          openQuestions: ["Question: should we support Ollama first?"],
          risks: ["Blocked by provider setup"]
        },
        todos: [],
        volatileContext: [],
        provenance: {
          openQuestions: [{ value: "Question: should we support Ollama first?", refs: [{ id: "evt-q-old", sourceType: "event", kind: "question" }] }],
          risks: [{ value: "Blocked by provider setup", refs: [{ id: "evt-r-old", sourceType: "event", kind: "constraint" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-decision",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-decision",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We decide to support Ollama first for local model setup"
          })
        },
        {
          eventId: "evt-status",
          reason: "working_note_signal",
          features: { kind: "status", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-status",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Status update: unblocked provider setup"
          })
        }
      ]
    });

    expect(merged.workingNotes.openQuestions).toEqual([]);
    expect(merged.workingNotes.risks).toEqual([]);
  });

  it("applies stream deltas chronologically so older questions do not re-open after later decisions", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        provenance: {},
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-decision",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-decision",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We decide to support Ollama first for local model setup",
            createdAt: new Date("2026-03-19T00:00:10Z")
          })
        },
        {
          eventId: "evt-question",
          reason: "working_note_signal",
          features: { kind: "question", importanceScore: 0.6, noveltyScore: 0.9 },
          event: event({
            id: "evt-question",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Question: should we support Ollama first?",
            createdAt: new Date("2026-03-19T00:00:01Z")
          })
        }
      ]
    });

    expect(merged.workingNotes.openQuestions).toEqual([]);
    expect(merged.recentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "openQuestions", action: "add", value: "Question: should we support Ollama first?" }),
        expect.objectContaining({ field: "openQuestions", action: "remove", value: "Question: should we support Ollama first?" })
      ])
    );
  });

  it("does not re-open a resolved question when the same question signal appears later in the merge pass", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          openQuestions: ["Question: should we support Ollama first?"]
        },
        todos: [],
        volatileContext: [],
        provenance: {
          openQuestions: [{ value: "Question: should we support Ollama first?", refs: [{ id: "evt-q-old", sourceType: "event", kind: "question" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-decision",
          reason: "stable_fact_signal",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "evt-decision",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "We decide to support Ollama first for local model setup"
          })
        },
        {
          eventId: "evt-question-repeat",
          reason: "working_note_signal",
          features: { kind: "question", importanceScore: 0.6, noveltyScore: 0.9 },
          event: event({
            id: "evt-question-repeat",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Question: should we support Ollama first?"
          })
        }
      ]
    });

    expect(merged.workingNotes.openQuestions).toEqual([]);
  });

  it("treats blocked events as risks instead of stable constraints", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: ["self-hosted first"],
          decisions: []
        },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        provenance: {
          constraints: [{ value: "self-hosted first", refs: [{ id: "doc-1", sourceType: "document", key: "doc:constraints" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-blocked",
          reason: "working_note_signal",
          features: { kind: "note", importanceScore: 0.6, noveltyScore: 0.9 },
          event: event({
            id: "evt-blocked",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Blocked by provider setup"
          })
        }
      ]
    });

    expect(merged.stableFacts.constraints).toEqual(["self-hosted first"]);
    expect(merged.workingNotes.risks).toEqual(["Blocked by provider setup"]);
  });

  it("removes resolved blocker context from volatile context when the risk is cleared", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          risks: ["Blocked by provider setup"]
        },
        todos: [],
        volatileContext: ["Blocked by provider setup", "Status update: queue is stable"],
        provenance: {
          risks: [{ value: "Blocked by provider setup", refs: [{ id: "evt-risk", sourceType: "event", kind: "note" }] }],
          volatileContext: [
            { value: "Blocked by provider setup", refs: [{ id: "evt-risk", sourceType: "event", kind: "note" }] },
            { value: "Status update: queue is stable", refs: [{ id: "evt-status-old", sourceType: "event", kind: "status" }] }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-status",
          reason: "working_note_signal",
          features: { kind: "status", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-status",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Status update: unblocked provider setup"
          })
        }
      ]
    });

    expect(merged.workingNotes.risks).toEqual([]);
    expect(merged.volatileContext).toEqual(["Status update: queue is stable", "Status update: unblocked provider setup"]);
  });

  it("does not re-add resolved blocker notes into volatile context later in the same merge", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {
          risks: ["Blocked by provider setup"]
        },
        todos: [],
        volatileContext: [],
        provenance: {
          risks: [{ value: "Blocked by provider setup", refs: [{ id: "evt-risk", sourceType: "event", kind: "note" }] }]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-status",
          reason: "working_note_signal",
          features: { kind: "status", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-status",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Status update: unblocked provider setup",
            createdAt: new Date("2026-03-19T00:00:01Z")
          })
        },
        {
          eventId: "evt-blocked-late",
          reason: "working_note_signal",
          features: { kind: "note", importanceScore: 0.6, noveltyScore: 0.9 },
          event: event({
            id: "evt-blocked-late",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "Blocked by provider setup",
            createdAt: new Date("2026-03-19T00:00:02Z")
          })
        }
      ]
    });

    expect(merged.workingNotes.risks).toEqual([]);
    expect(merged.volatileContext ?? []).not.toContain("Blocked by provider setup");
  });

  it("removes matching todos when a stream event marks them done or cancelled", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: []
        },
        workingNotes: {},
        todos: ["publish benchmark report", "ship runtime"],
        provenance: {
          todos: [
            { value: "publish benchmark report", refs: [{ id: "evt-old", sourceType: "event", kind: "todo" }] },
            { value: "ship runtime", refs: [{ id: "evt-old-2", sourceType: "event", kind: "todo" }] }
          ]
        },
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [
        {
          eventId: "evt-done",
          reason: "stable_fact_signal",
          features: { kind: "todo", importanceScore: 0.8, noveltyScore: 0.9 },
          event: event({
            id: "evt-done",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "completed publish benchmark report"
          })
        }
      ]
    });

    expect(merged.todos).toEqual(["ship runtime"]);
    expect(merged.recentChanges).toContainEqual(
      expect.objectContaining({ field: "todos", action: "remove", value: "publish benchmark report" })
    );
  });

  it("normalizes legacy string evidence refs from previous snapshots", () => {
    const normalized = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      volatileContext: [],
      evidenceRefs: ["doc:goal", "e1"] as any
    });

    expect(normalized.evidenceRefs).toEqual([
      { id: "doc:goal", sourceType: "document", key: "doc:goal" },
      { id: "e1", sourceType: "event" }
    ]);
  });

  it("normalizes provenance and recent changes from previous snapshots", () => {
    const normalized = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      volatileContext: [],
      evidenceRefs: [],
      provenance: {
        goal: ["doc:goal"] as any,
        todos: [{ value: "ship runtime", refs: ["e1"] }] as any
      },
      recentChanges: [
        { field: "goal", action: "set", value: "ship alpha", evidence: "doc:goal" },
        { field: "todos", action: "add", value: "ship runtime", evidence: "e1" }
      ] as any
    });

    expect(normalized.provenance?.goal).toEqual([{ id: "doc:goal", sourceType: "document", key: "doc:goal" }]);
    expect(normalized.provenance?.todos).toEqual([
      {
        value: "ship runtime",
        refs: [{ id: "e1", sourceType: "event" }]
      }
    ]);
    expect(normalized.recentChanges).toEqual([
      {
        field: "goal",
        action: "set",
        value: "ship alpha",
        evidence: { id: "doc:goal", sourceType: "document", key: "doc:goal" }
      },
      {
        field: "todos",
        action: "add",
        value: "ship runtime",
        evidence: { id: "e1", sourceType: "event" }
      }
    ]);
    expect(normalized.confidence?.goal).toBe(1);
    expect(normalized.confidence?.todos).toEqual([
      {
        value: "ship runtime",
        score: 0.7
      }
    ]);
    expect(normalized.transitionSummary).toEqual({});
  });

  it("treats recent changes and transition summary as snapshot-local", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: { goal: "ship alpha", constraints: ["self-hosted first"], decisions: [] },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        evidenceRefs: [],
        transitionSummary: { "goal:set": 1, "constraints:add": 1 },
        recentChanges: [
          {
            field: "goal",
            action: "set",
            value: "ship alpha",
            evidence: { id: "doc-old", sourceType: "document", key: "doc:goal" }
          }
        ],
        provenance: {
          goal: [{ id: "doc-old", sourceType: "document", key: "doc:goal" }],
          constraints: [{ value: "self-hosted first", refs: [{ id: "doc-old", sourceType: "document", key: "doc:plan" }] }]
        }
      },
      documents: [
        event({
          id: "doc-new",
          scopeId: "sc",
          userId: "u",
          type: "document",
          key: "doc:plan",
          content: "constraint: self-hosted first"
        })
      ],
      deltaCandidates: []
    });

    expect(merged.recentChanges).toEqual([
      expect.objectContaining({ field: "constraints", action: "reaffirm", value: "self-hosted first" })
    ]);
    expect(merged.transitionSummary).toEqual({
      "constraints:reaffirm": 1
    });
  });
});

describe("consistencyCheck", () => {
  it("catches contradictions and vague next steps", () => {
    const result = consistencyCheck({
      output: {
        summary: "goal: rewrite everything now",
        changes: ["same change"],
        nextSteps: ["clarify"]
      },
      previousDigest: {
        id: "d1",
        scopeId: "sc",
        summary: "old",
        changes: "- same change",
        nextSteps: ["test api"],
        createdAt: new Date()
      },
      protectedState: {
        stableFacts: { goal: "ship alpha", constraints: [], decisions: [] },
        workingNotes: {},
        todos: []
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("goal_contradiction");
    expect(result.errors).toContain("changes_repeated_from_previous_digest");
    expect(result.errors).toContain("vague_next_step");
  });

  it("catches decision and todo contradictions against protected state", () => {
    const result = consistencyCheck({
      output: {
        summary: "We should revert the postgres choice and remove benchmark coverage.",
        changes: [
          "Revert use postgres for storage",
          "Remove define drift metrics from the roadmap"
        ],
        nextSteps: ["Document replacement storage plan"]
      },
      protectedState: {
        stableFacts: {
          goal: "ship alpha",
          constraints: [],
          decisions: ["use postgres for storage"]
        },
        workingNotes: {},
        todos: ["define drift metrics"]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("decision_contradiction");
    expect(result.errors).toContain("todo_contradiction");
  });

  it("catches goal and constraint omissions when protected facts disappear entirely", () => {
    const result = consistencyCheck({
      output: {
        summary: "Worked on benchmark polish and queue cleanup.",
        changes: ["Updated benchmark markdown output"],
        nextSteps: ["Write queue latency notes"]
      },
      protectedState: {
        stableFacts: {
          goal: "ship low drift memory runtime",
          constraints: ["self-hosted first", "keep api stable"],
          decisions: []
        },
        workingNotes: {},
        todos: []
      }
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("goal_omission");
    expect(result.warnings).toContain("constraint_omission");
  });

  it("catches decision and todo omissions when durable state disappears from the digest", () => {
    const result = consistencyCheck({
      output: {
        summary: "Worked on benchmark polish and queue cleanup.",
        changes: ["Updated benchmark markdown output"],
        nextSteps: ["Write queue latency notes"]
      },
      protectedState: {
        stableFacts: {
          goal: "ship low drift memory runtime",
          constraints: [],
          decisions: ["use postgres for storage"]
        },
        workingNotes: {},
        todos: ["define drift metrics"]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("decision_omission");
    expect(result.warnings).toContain("todo_omission");
  });

  it("does not flag todo omission when next steps mention the todo without the TODO prefix", () => {
    const result = consistencyCheck({
      output: {
        summary: "Worked on benchmark polish and queue cleanup.",
        changes: ["Updated benchmark markdown output"],
        nextSteps: ["Add benchmark assertion for p95 latency group 54"]
      },
      protectedState: {
        stableFacts: {
          goal: "ship low drift memory runtime",
          constraints: [],
          decisions: []
        },
        workingNotes: {},
        todos: ["TODO: add benchmark assertion for p95 latency group 54"]
      }
    });

    expect(result.warnings).not.toContain("todo_omission");
  });
});

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
        summary: "The user no longer worked at 字节跳动 from 2019-2022.",
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

describe("generateDigestStage2", () => {
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

    expect(result.summary).toContain("Goal: ship alpha");
    expect(result.summary).toContain("no paid APIs");
    expect(result.summary).toContain("benchmarking");
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

  it("retries after invalid output and succeeds with mocked llm", async () => {
    const responses = [
      "{\"summary\":\"too short\",\"changes\":[\"same\"],\"nextSteps\":[\"clarify\"]}",
      "{\"summary\":\"Shipped API endpoints and investigated queue performance.\",\"changes\":[\"Added endpoint tests\"],\"nextSteps\":[\"Write benchmark script for queue latency\"]}"
    ];
    const llm = {
      chat: async () => responses.shift() as string
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: { stableFacts: { goal: "ship alpha", constraints: [], decisions: [] }, workingNotes: {}, todos: [] },
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 1
    });

    expect(result.nextSteps[0]).toContain("Write benchmark script");
  });

  it("aligns digest output back to protected state for decisions, open questions, and todos", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"Worked on benchmark polish.\",\"changes\":[\"Updated benchmark markdown output\"],\"nextSteps\":[\"Write queue latency notes\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: {
        stableFacts: {
          goal: "ship low drift memory runtime",
          constraints: [],
          decisions: ["use postgres for storage"]
        },
        workingNotes: {
          openQuestions: ["should we support ollama first"]
        },
        todos: ["define drift metrics"]
      },
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    const combined = [result.summary, ...result.changes, ...result.nextSteps].join("\n").toLowerCase();
    expect(combined).toContain("use postgres for storage");
    expect(combined).toContain("should we support ollama first");
    expect(result.nextSteps.join("\n").toLowerCase()).toContain("define drift metrics");
  });

  it("aligns digest summary with active constraints and risks from protected state", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"We are making progress.\",\"changes\":[],\"nextSteps\":[\"document runtime evidence output\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: {
        stableFacts: {
          goal: "ship low drift memory runtime",
          constraints: ["self-hosted first", "keep evaluation reproducible"],
          decisions: []
        },
        workingNotes: {
          risks: ["drift metrics may regress during runtime refactors"]
        },
        todos: ["document runtime evidence output"]
      },
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    expect(result.summary).toContain("self-hosted first");
    expect(result.summary).toContain("keep evaluation reproducible");
    expect(result.summary).toContain("ship low drift memory runtime");
    expect(result.summary.toLowerCase()).toContain("active risk");
    expect(result.summary).toContain("drift metrics may regress during runtime refactors");
  });

  it("keeps all short active constraints in the projected digest summary when they fit", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"We are making progress.\",\"changes\":[],\"nextSteps\":[\"document runtime evidence output\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: {
        stableFacts: {
          goal: "ship a self-hosted long-term memory runtime for local models",
          constraints: [
            "keep api stable",
            "self-hosted first",
            "do not become a general-purpose agent platform"
          ],
          decisions: []
        },
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

    expect(result.summary).toContain("keep api stable");
    expect(result.summary).toContain("self-hosted first");
    expect(result.summary).toContain("do not become a general-purpose agent platform");
  });

  it("projects recent state transitions back into digest changes", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"We are making progress.\",\"changes\":[],\"nextSteps\":[\"document runtime evidence output\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: normalizeDigestState({
        stableFacts: {
          goal: "ship low drift memory runtime",
          constraints: ["self-hosted first"],
          decisions: ["We decide to support Ollama first for local model setup"]
        },
        workingNotes: {
          openQuestions: ["Question: should we also support LM Studio?"],
          risks: ["Risk: drift metrics may regress during runtime refactors"]
        },
        todos: ["document runtime evidence output"],
        recentChanges: [
          {
            field: "decisions",
            action: "add",
            value: "We decide to support Ollama first for local model setup",
            evidence: { id: "evt-decision", sourceType: "event", kind: "decision" }
          },
          {
            field: "openQuestions",
            action: "add",
            value: "Question: should we also support LM Studio?",
            evidence: { id: "evt-question", sourceType: "event", kind: "question" }
          },
          {
            field: "risks",
            action: "add",
            value: "Risk: drift metrics may regress during runtime refactors",
            evidence: { id: "evt-risk", sourceType: "event", kind: "note" }
          }
        ],
        evidenceRefs: []
      }),
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    const combinedChanges = result.changes.join("\n");
    expect(combinedChanges).toContain("Decision: We decide to support Ollama first for local model setup");
    expect(combinedChanges).toContain("Open question: Question: should we also support LM Studio?");
  });

  it("does not project removed conflicting decisions back into digest changes", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"We are making progress.\",\"changes\":[],\"nextSteps\":[\"document runtime evidence output\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: normalizeDigestState({
        stableFacts: {
          goal: "ship self-hosted memory control",
          constraints: [],
          decisions: ["We decide to keep the assistant runtime as a product boundary"]
        },
        workingNotes: {},
        todos: ["document runtime evidence output"],
        recentChanges: [
          {
            field: "decisions",
            action: "remove",
            value: "We decide to merge every memory layer into one prompt path",
            evidence: { id: "evt-old", sourceType: "event", kind: "decision" }
          },
          {
            field: "decisions",
            action: "add",
            value: "We decide to keep the assistant runtime as a product boundary",
            evidence: { id: "evt-new", sourceType: "event", kind: "decision" }
          }
        ],
        evidenceRefs: []
      }),
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    const combinedChanges = result.changes.join("\n");
    expect(combinedChanges).toContain("Decision: We decide to keep the assistant runtime as a product boundary");
    expect(combinedChanges).not.toContain("We decide to merge every memory layer into one prompt path");
  });

  it("does not project transient cleanup todos into digest changes", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"We are making progress.\",\"changes\":[],\"nextSteps\":[\"document runtime evidence output\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: normalizeDigestState({
        stableFacts: {
          goal: "ship self-hosted memory control",
          constraints: [],
          decisions: []
        },
        workingNotes: {},
        todos: ["TODO: document runtime evidence output", "TODO: sort tmp logs"],
        recentChanges: [
          {
            field: "todos",
            action: "add",
            value: "TODO: sort tmp logs",
            evidence: { id: "evt-tmp", sourceType: "event", kind: "todo" }
          },
          {
            field: "todos",
            action: "add",
            value: "TODO: document runtime evidence output",
            evidence: { id: "evt-durable", sourceType: "event", kind: "todo" }
          }
        ],
        evidenceRefs: []
      }),
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    const combinedChanges = result.changes.join("\n");
    expect(combinedChanges).toContain("Todo: TODO: document runtime evidence output");
    expect(combinedChanges).not.toContain("TODO: sort tmp logs");
  });

  it("prefers state-projected summary and next steps over model wording variance", async () => {
    const llm = {
      chat: async () => JSON.stringify({
        summary: "Assistant reply: we made progress on a hosted deployment path and may revisit the queue issue later.",
        changes: [
          "Assistant reply: We decided to focus on throughput",
          "Random reformulation of the risk"
        ],
        nextSteps: [
          "TODO: add benchmark assertion for p95 latency group 54",
          "monitor queue later"
        ]
      })
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: normalizeDigestState({
        stableFacts: {
          goal: "ship benchmarkable memory engine v1",
          constraints: ["no hosted dependency", "keep api stable"],
          decisions: ["We decide to prioritize ingestion throughput batch 50"]
        },
        workingNotes: {
          risks: ["Blocked by queue visibility timeout around item 51"]
        },
        todos: ["TODO: add benchmark assertion for p95 latency group 54"],
        recentChanges: [
          {
            field: "decisions",
            action: "add",
            value: "We decide to prioritize ingestion throughput batch 50",
            evidence: { id: "evt-decision", sourceType: "event", kind: "decision" }
          },
          {
            field: "risks",
            action: "add",
            value: "Blocked by queue visibility timeout around item 51",
            evidence: { id: "evt-risk", sourceType: "event", kind: "note" }
          }
        ],
        evidenceRefs: []
      }),
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    expect(result.summary).toContain("Goal: ship benchmarkable memory engine v1.");
    expect(result.summary).toContain("Constraints: no hosted dependency; keep api stable.");
    // Narrative is now appended after the state prefix rather than discarded.
    expect(result.summary).toContain("hosted deployment path");
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Decision: We decide to prioritize ingestion throughput batch 50",
        "Risk: Blocked by queue visibility timeout around item 51"
      ])
    );
    expect(result.changes.join("\n")).not.toContain("Assistant reply:");
    expect(result.nextSteps).toEqual([
      "Add benchmark assertion for p95 latency group 54",
      "Investigate and resolve Blocked by queue visibility timeout around item 51"
    ]);
  });

  it("projects multiple durable decisions into the summary when they fit within budget", async () => {
    const llm = {
      chat: async () => JSON.stringify({
        summary: "Worked on digest maintenance.",
        changes: ["Updated digest notes"],
        nextSteps: ["review metrics"]
      })
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: null,
      protectedState: normalizeDigestState({
        stableFacts: {
          goal: "maximize digest consistency under noisy streams",
          constraints: ["avoid hosted dependencies", "keep api stable"],
          decisions: [
            "We decide to prioritize consistency batch 0",
            "We decide to prioritize consistency batch 3",
            "We decide to prioritize consistency batch 5",
            "We decide to prioritize consistency batch 7",
            "We decide to prioritize consistency batch 10",
            "We decide to prioritize consistency batch 13",
            "We decide to prioritize consistency batch 16",
            "We decide to prioritize consistency batch 19"
          ]
        },
        workingNotes: {},
        todos: [],
        recentChanges: [],
        evidenceRefs: []
      }),
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    const normalizedSummary = result.summary.toLowerCase();
    expect(normalizedSummary).toContain("we decide to prioritize consistency batch 0");
    expect(normalizedSummary).toContain("we decide to prioritize consistency batch 19");
    expect(result.summary.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
  });

  it("returns no-change digest when only repeated changes are detected", async () => {
    const llm = {
      chat: async () => "{\"summary\":\"ok\",\"changes\":[\"same change\"],\"nextSteps\":[\"Test pipeline\"]}"
    };

    const result = await generateDigestStage2({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: {
        id: "d1",
        scopeId: "s",
        summary: "goal: ship alpha",
        changes: "- same change",
        nextSteps: ["Test pipeline"],
        createdAt: new Date()
      },
      protectedState: { stableFacts: { goal: "ship alpha", constraints: [], decisions: [] }, workingNotes: {}, todos: [] },
      deltaCandidates: [],
      documents: [],
      llm,
      systemPrompt: "system",
      userPromptTemplate: "{{scopeName}} {{lastDigest}} {{protectedState}} {{deltaCandidates}} {{documents}}",
      maxRetries: 0
    });

    expect(result.changes.length).toBe(0);
    expect(result.summary).toContain("goal: ship alpha");
  });
});

describe("runDigestControlPipeline", () => {
  it("returns a no-change digest when no events are newer than the last digest", async () => {
    const lastDigestCreatedAt = new Date("2026-03-19T00:00:10Z");
    const result = await runDigestControlPipeline({
      scope: { id: "s", userId: "u", name: "Demo", goal: "ship alpha", stage: "build", createdAt: new Date() },
      lastDigest: {
        id: "d1",
        scopeId: "s",
        summary: "Goal: ship alpha.",
        changes: "- Decision: use postgres",
        nextSteps: ["Add benchmark assertion"],
        createdAt: lastDigestCreatedAt
      },
      prevState: normalizeDigestState({
        stableFacts: { goal: "ship alpha", constraints: [], decisions: ["use postgres"] },
        workingNotes: {},
        todos: ["Add benchmark assertion"],
        recentChanges: [
          {
            field: "decisions",
            action: "add",
            value: "use postgres",
            evidence: { id: "evt-1", sourceType: "event", kind: "decision" }
          }
        ],
        evidenceRefs: [{ id: "evt-1", sourceType: "event", kind: "decision" }]
      }),
      recentEvents: [
        event({
          id: "evt-old",
          scopeId: "s",
          userId: "u",
          type: "stream",
          content: "We decide to use postgres",
          createdAt: new Date("2026-03-19T00:00:01Z")
        })
      ],
      llm: {
        chat: async () => {
          throw new Error("llm should not be called");
        }
      },
      prompts: {
        digestStage2SystemPrompt: "system",
        digestStage2UserPrompt: "{{scopeName}}"
      },
      config: {
        eventBudgetTotal: 10,
        eventBudgetDocs: 5,
        eventBudgetStream: 5,
        noveltyThreshold: 0.5,
        maxRetries: 1,
        useLlmClassifier: false,
        debug: false
      }
    });

    expect(result.digest).toEqual({
      summary: "Goal: ship alpha.",
      changes: [],
      nextSteps: ["Add benchmark assertion"]
    });
    expect(result.selection.rationale).toContain("no_new_events_since_last_digest");
    expect(result.metrics.generationMs).toBe(0);
  });
});

describe("factRegistry", () => {
  it("normalizeDigestState preserves factRegistry entries", () => {
    const entry: FactRegistryEntry = {
      id: "fact-1",
      content: "use ONNX for inference",
      type: "decision",
      confidence: 0.9,
      addedAt: "2026-01-01T00:00:00.000Z",
      evidenceId: "evt-1",
      evidenceType: "event"
    };
    const state = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [entry]
    });
    expect(state.factRegistry).toHaveLength(1);
    expect(state.factRegistry![0].content).toBe("use ONNX for inference");
  });

  it("normalizeDigestState initializes empty factRegistry when absent", () => {
    const state = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: []
    });
    expect(state.factRegistry).toEqual([]);
  });

  it("getActiveFactRegistry excludes superseded entries", () => {
    const state = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {},
      todos: [],
      factRegistry: [
        { id: "f1", content: "old decision", type: "decision", confidence: 0.8, addedAt: "2026-01-01T00:00:00.000Z", evidenceId: "e1", evidenceType: "event", supersededBy: "f2" },
        { id: "f2", content: "new decision", type: "decision", confidence: 0.9, addedAt: "2026-01-02T00:00:00.000Z", evidenceId: "e2", evidenceType: "document" }
      ]
    });
    const active = getActiveFactRegistry(state);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("f2");
  });

  it("promotes high-importance decisions to factRegistry", () => {
    const result = protectedStateMerge({
      prevState: normalizeDigestState(null),
      deltaCandidates: [{
        eventId: "evt-1",
        reason: "decision",
        features: { kind: "decision", importanceScore: 0.85, noveltyScore: 0.9 },
        event: event({ id: "evt-1", scopeId: "sc", userId: "u", type: "stream", content: "decision: use ONNX runtime, no GPU required for V1" })
      }],
      documents: []
    });
    const active = getActiveFactRegistry(result);
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe("decision");
    expect(active[0].confidence).toBe(0.85);
  });

  it("does not promote low-importance decisions to factRegistry", () => {
    const result = protectedStateMerge({
      prevState: normalizeDigestState(null),
      deltaCandidates: [{
        eventId: "evt-2",
        reason: "decision",
        features: { kind: "decision", importanceScore: 0.4, noveltyScore: 0.9 },
        event: event({ id: "evt-2", scopeId: "sc", userId: "u", type: "stream", content: "decision: use prettier for formatting" })
      }],
      documents: []
    });
    expect(getActiveFactRegistry(result)).toHaveLength(0);
  });

  it("promotes constraints to factRegistry when importanceScore >= 0.75", () => {
    const result = protectedStateMerge({
      prevState: normalizeDigestState(null),
      deltaCandidates: [{
        eventId: "evt-3",
        reason: "constraint",
        features: { kind: "constraint", importanceScore: 0.8, noveltyScore: 0.9 },
        event: event({ id: "evt-3", scopeId: "sc", userId: "u", type: "stream", content: "constraint: no paid third-party APIs in V1" })
      }],
      documents: []
    });
    const active = getActiveFactRegistry(result);
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe("constraint");
  });

  it("stream events cannot remove a factRegistry decision via revoke", () => {
    const stateWithFact = protectedStateMerge({
      prevState: normalizeDigestState(null),
      deltaCandidates: [{
        eventId: "evt-1",
        reason: "decision",
        features: { kind: "decision", importanceScore: 0.85, noveltyScore: 0.9 },
        event: event({ id: "evt-1", scopeId: "sc", userId: "u", type: "stream", content: "decision: use ONNX runtime for V1" })
      }],
      documents: []
    });
    expect(getActiveFactRegistry(stateWithFact)).toHaveLength(1);

    const stateAfterRevoke = protectedStateMerge({
      prevState: stateWithFact,
      deltaCandidates: [{
        eventId: "evt-2",
        reason: "decision",
        features: { kind: "decision", importanceScore: 0.8, noveltyScore: 0.9 },
        event: event({ id: "evt-2", scopeId: "sc", userId: "u", type: "stream", content: "revoke decision: ONNX runtime" })
      }],
      documents: []
    });
    expect(getActiveFactRegistry(stateAfterRevoke)).toHaveLength(1);
    expect(getActiveFactRegistry(stateAfterRevoke)[0].content).toContain("ONNX");
  });

  it("stream events cannot remove a factRegistry decision via conflict", () => {
    const stateWithFact = protectedStateMerge({
      prevState: normalizeDigestState(null),
      deltaCandidates: [{
        eventId: "evt-1",
        reason: "decision",
        features: { kind: "decision", importanceScore: 0.85, noveltyScore: 0.9 },
        event: event({ id: "evt-1", scopeId: "sc", userId: "u", type: "stream", content: "decision: use ONNX runtime for inference" })
      }],
      documents: []
    });
    expect(stateWithFact.stableFacts.decisions).toHaveLength(1);
    expect(getActiveFactRegistry(stateWithFact)).toHaveLength(1);

    // Conflicting decision via stream event — should NOT remove the registry-protected decision
    const stateAfterConflict = protectedStateMerge({
      prevState: stateWithFact,
      deltaCandidates: [{
        eventId: "evt-2",
        reason: "decision",
        features: { kind: "decision", importanceScore: 0.8, noveltyScore: 0.9 },
        event: event({ id: "evt-2", scopeId: "sc", userId: "u", type: "stream", content: "decision: use TensorFlow instead of ONNX for inference" })
      }],
      documents: []
    });
    expect(getActiveFactRegistry(stateAfterConflict)).toHaveLength(1);
    expect(getActiveFactRegistry(stateAfterConflict)[0].content).toContain("ONNX");
  });
});

describe("drift-fixes", () => {
  it("normalizeDigestState caps decisions and constraints at 100 to prevent unbounded growth", () => {
    const many = Array.from({ length: 105 }, (_, i) => `decision ${i}`);
    const state = normalizeDigestState({
      stableFacts: { decisions: many, constraints: many },
      workingNotes: {},
      todos: []
    });
    expect(state.stableFacts.decisions).toHaveLength(100);
    expect(state.stableFacts.constraints).toHaveLength(100);
    expect(state.stableFacts.decisions[0]).toBe("decision 5");
    expect(state.stableFacts.decisions[99]).toBe("decision 104");
  });

  it("does not log goal reaffirm when stream event mentions unrelated goal", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: { goal: "ship beta runtime", constraints: [], decisions: [] },
        workingNotes: {},
        todos: [],
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [{
        eventId: "evt-unrelated-goal",
        reason: "novel_event",
        features: { kind: "note", importanceScore: 0.5, noveltyScore: 0.9 },
        event: event({
          id: "evt-unrelated-goal",
          scopeId: "sc",
          userId: "u",
          type: "stream",
          content: "I want to fix the login authentication bug today"
        })
      }]
    });

    expect(merged.stableFacts.goal).toBe("ship beta runtime");
    expect(merged.recentChanges).not.toContainEqual(
      expect.objectContaining({ field: "goal", evidence: expect.objectContaining({ id: "evt-unrelated-goal" }) })
    );
  });

  it("removes all decisions that conflict with replacement language, not just the first", () => {
    const merged = protectedStateMerge({
      prevState: {
        stableFacts: {
          goal: "ship inference engine",
          constraints: [],
          decisions: ["use ONNX for inference", "ONNX is the primary model runtime"]
        },
        workingNotes: {},
        todos: [],
        recentChanges: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [{
        eventId: "evt-replace",
        reason: "stable_fact_signal",
        features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
        event: event({
          id: "evt-replace",
          scopeId: "sc",
          userId: "u",
          type: "stream",
          content: "We decided to use TensorRT instead of ONNX for inference"
        })
      }]
    });

    expect(merged.stableFacts.decisions).not.toContain("use ONNX for inference");
    expect(merged.stableFacts.decisions).not.toContain("ONNX is the primary model runtime");
    expect(merged.stableFacts.decisions).toContain("We decided to use TensorRT instead of ONNX for inference");
  });

  it("normalizeDigestState caps volatileContext openQuestions and risks at 10 to match protectedStateMerge", () => {
    const state = normalizeDigestState({
      stableFacts: { decisions: [] },
      workingNotes: {
        openQuestions: Array.from({ length: 15 }, (_, i) => `question ${i}`),
        risks: Array.from({ length: 15 }, (_, i) => `risk ${i}`)
      },
      todos: [],
      volatileContext: Array.from({ length: 15 }, (_, i) => `volatile ${i}`)
    });
    expect(state.workingNotes.openQuestions).toHaveLength(10);
    expect(state.workingNotes.risks).toHaveLength(10);
    expect(state.volatileContext).toHaveLength(10);
  });

  it("normalizeDigestState removes event evidenceRefs not referenced by any provenance entry", () => {
    const state = normalizeDigestState({
      stableFacts: { decisions: ["use postgres"] },
      workingNotes: {},
      todos: [],
      evidenceRefs: [
        { id: "evt-active", sourceType: "event", kind: "decision" },
        { id: "evt-orphan", sourceType: "event", kind: "decision" },
        { id: "doc-1", sourceType: "document", key: "doc:plan" }
      ],
      provenance: {
        decisions: [{ value: "use postgres", refs: [{ id: "evt-active", sourceType: "event", kind: "decision" }] }]
      }
    });

    const ids = state.evidenceRefs?.map((r) => r.id) ?? [];
    expect(ids).toContain("evt-active");
    expect(ids).toContain("doc-1");
    expect(ids).not.toContain("evt-orphan");
  });
});

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

describe("runDigestControlPipeline → state.profile.identity from document profileFacts", () => {
  it("routes LLM-extracted profileFacts[facet=identity] into result.state.profile.identity", async () => {
    const mockLlm = {
      chat: async (_messages: { role: "system" | "user"; content: string }[]) => {
        return JSON.stringify({
          summary: "Processed resume.",
          changes: ["Resume ingested."],
          nextSteps: ["Review extracted identity facts."],
          profileFacts: [{ facet: "identity", value: "工作经历: 字节跳动 后端工程师 2019-2022" }]
        });
      }
    };

    const resumeDoc = event({
      id: "doc-resume",
      scopeId: "sc",
      userId: "u",
      type: "document",
      key: "resume:main",
      content: "工作经历: 字节跳动 后端工程师 2019-2022",
      createdAt: new Date("2026-06-20T10:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: { id: "sc", userId: "u", name: "personal", goal: null, stage: "build", createdAt: new Date() },
      recentEvents: [resumeDoc],
      llm: mockLlm,
      prompts: {
        digestStage2SystemPrompt: "Output JSON only.",
        digestStage2UserPrompt: "{{scopeName}}"
      },
      config: {
        eventBudgetTotal: 10,
        eventBudgetDocs: 5,
        eventBudgetStream: 5,
        noveltyThreshold: 0.5,
        maxRetries: 0,
        useLlmClassifier: false,
        debug: false
      }
    });

    expect(result.state.profile?.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
  });
});

describe("applyProfileFactsFromDigest — supersession preserves identity attributes (Fix 1)", () => {
  const baseStreamState: DigestState = {
    stableFacts: { decisions: [] },
    workingNotes: {},
    todos: [],
    profile: { identity: ["工作经历: 字节跳动 后端工程师 2019-2022"] },
    factRegistry: [{
      id: "stream-fact-1",
      content: "工作经历: 字节跳动 后端工程师 2019-2022",
      type: "profile",
      confidence: 0.7,
      facet: "identity",
      addedAt: "2026-01-01T00:00:00.000Z",
      evidenceId: "stream-evt-1",
      evidenceType: "event"
    }]
  };

  const resumeDoc = event({
    id: "doc-resume",
    scopeId: "sc",
    userId: "u",
    type: "document",
    key: "resume:main",
    content: "工作经历: 字节跳动 后端工程师 2019-2022",
    createdAt: new Date("2026-06-20T10:00:00Z")
  });

  const mockLlmWithFacts = {
    chat: async (_messages: { role: "system" | "user"; content: string }[]) => {
      return JSON.stringify({
        summary: "Processed resume.",
        changes: ["Resume ingested."],
        nextSteps: ["Review extracted identity facts."],
        profileFacts: [{ facet: "identity", value: "工作经历: 字节跳动 后端工程师 2019-2022" }]
      });
    }
  };

  const pipelineConfig = {
    scope: { id: "sc", userId: "u", name: "personal", goal: null, stage: "build" as const, createdAt: new Date() },
    recentEvents: [resumeDoc],
    llm: mockLlmWithFacts,
    prompts: {
      digestStage2SystemPrompt: "Output JSON only.",
      digestStage2UserPrompt: "{{scopeName}}"
    },
    config: {
      eventBudgetTotal: 10,
      eventBudgetDocs: 5,
      eventBudgetStream: 5,
      noveltyThreshold: 0.5,
      maxRetries: 0,
      useLlmClassifier: false,
      debug: false
    }
  };

  it("active factRegistry entry after doc supersession has facet=identity, confidence=0.85, type=profile, evidenceType=document", async () => {
    const result = await runDigestControlPipeline({ ...pipelineConfig, prevState: baseStreamState });

    const active = getActiveFactRegistry(result.state);
    const identityEntry = active.find((e) => e.content.includes("字节跳动"));
    expect(identityEntry).toBeDefined();
    expect(identityEntry!.facet).toBe("identity");
    expect(identityEntry!.confidence).toBe(0.85);
    expect(identityEntry!.type).toBe("profile");
    expect(identityEntry!.evidenceType).toBe("document");
  });

  it("subsequent contradicting stream event does NOT overwrite document-authority identity fact after supersession", async () => {
    const result1 = await runDigestControlPipeline({ ...pipelineConfig, prevState: baseStreamState });

    // Conflicting stream event with Jaccard >= 0.6 overlap
    const contradictingEvt = event({
      id: "stream-contradiction",
      scopeId: "sc",
      userId: "u",
      type: "stream",
      content: "工作经历: 字节跳动 前端工程师 2019-2022",
      classifiedType: "personal_detail",
      createdAt: new Date("2026-06-20T11:00:00Z")
    });

    const stateAfterConflict = protectedStateMerge({
      prevState: result1.state,
      deltaCandidates: [{
        eventId: "stream-contradiction",
        reason: "novel_event",
        features: { kind: "note", importanceScore: 0.5, noveltyScore: 0.8 },
        event: contradictingEvt
      }],
      documents: []
    });

    // Original document-authority value must survive
    expect(stateAfterConflict.profile?.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
    expect(stateAfterConflict.profile?.identity).not.toContain("工作经历: 字节跳动 前端工程师 2019-2022");
  });
});

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

  it("字节跳动 appears in the rendered State block under 你是谁/档案: after resume digest", async () => {
    const resumeDoc = event({
      id: "doc-resume-b2",
      scopeId: "sc-personal-b2",
      userId: "u1",
      type: "document",
      key: "resume:main",
      content: "工作经历: 字节跳动 后端工程师 2019-2022\n教育: 北京大学 计算机科学 2015-2019",
      createdAt: new Date("2026-06-20T10:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: {
        id: "sc-personal-b2",
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

    // Probe B2 north-star: 字节跳动 must appear in the rendered State block under 你是谁/档案:
    expect(result.state.profile?.identity).toBeDefined();
    const rendered = formatStateLayerView(compileStateLayerView(result.state));
    expect(rendered).toContain("你是谁/档案:");
    expect(rendered).toContain("字节跳动");
  });

  it("project-template non-regression: no profile sections, stable goal retained", async () => {
    const projectEvent = event({
      id: "e-decision-b2",
      scopeId: "sc-project-b2",
      userId: "u1",
      type: "stream",
      content: "We decide to use Postgres for the main database",
      createdAt: new Date("2026-06-20T10:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: {
        id: "sc-project-b2",
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

    const rendered = formatStateLayerView(compileStateLayerView(result.state));
    expect(rendered).not.toContain("你是谁");
    expect(rendered).not.toContain("人际");
    expect(rendered).not.toContain("正在经历");
    expect(rendered).toContain("Stable goal: ship stable API");
  });

  it("identity facts are write-protected: factRegistry has facet=identity entries at 0.85 confidence after resume digest", async () => {
    const resumeDoc = event({
      id: "doc-resume-b2-wp",
      scopeId: "sc-personal-b2-wp",
      userId: "u1",
      type: "document",
      key: "resume:secondary",
      content: "工作经历: 字节跳动 后端工程师 2019-2022",
      createdAt: new Date("2026-06-20T11:00:00Z")
    });

    const result = await runDigestControlPipeline({
      scope: {
        id: "sc-personal-b2-wp",
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

describe("CJK bigram tokenizer (engine-level)", () => {
  // Helper: minimal DigestState with decisions pre-seeded
  function stateWithDecisions(decisions: string[]): import("./digest-control").DigestState {
    return {
      stableFacts: { decisions, constraints: [], goal: undefined },
      workingNotes: {},
      todos: [],
      volatileContext: [],
      evidenceRefs: []
    };
  }

  it("deduplicates near-identical Chinese decisions (high Jaccard via CJK bigrams)", () => {
    // "我们决定用PostgreSQL管理数据" vs "我们决定用PostgreSQL管理数据库"
    // Bigrams of "我们决定用": 我们,们决,决定,定用; "管理数据": 管理,理数,数据
    // Bigrams of "我们决定用": same 4; "管理数据库": 管理,理数,数据,据库
    // ASCII: ["postgresql"] in both
    // Intersection = {postgresql,我们,们决,决定,定用,管理,理数,数据} = 8; Union = 9 → Jaccard ≈ 0.89 ≥ 0.8 → dedup
    const state2 = protectedStateMerge({
      prevState: stateWithDecisions(["我们决定用PostgreSQL管理数据"]),
      documents: [],
      deltaCandidates: [
        {
          eventId: "cjk-e1",
          reason: "novel_event",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.3 },
          event: event({
            id: "cjk-e1",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "我们决定用PostgreSQL管理数据库"
          })
        }
      ]
    });
    expect(state2.stableFacts.decisions).toHaveLength(1);
  });

  it("★ OVER-MERGE GUARD: genuinely different Chinese facts are NOT deduped", () => {
    // "我对花生过敏" vs "我喜欢打篮球"
    // Bigrams: {我对,对花,花生,生过,过敏} vs {我喜,喜欢,欢打,打篮,篮球} — zero overlap → Jaccard = 0 ≪ 0.8
    const state2 = protectedStateMerge({
      prevState: stateWithDecisions(["我对花生过敏"]),
      documents: [],
      deltaCandidates: [
        {
          eventId: "cjk-e2",
          reason: "novel_event",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "cjk-e2",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "我喜欢打篮球"
          })
        }
      ]
    });
    expect(state2.stableFacts.decisions).toHaveLength(2);
    expect(state2.stableFacts.decisions).toContain("我对花生过敏");
    expect(state2.stableFacts.decisions).toContain("我喜欢打篮球");
  });

  it("English/ASCII dedup behavior is unchanged by CJK path", () => {
    // "use Redis for caching" vs "use Redis for session caching"
    // Tokens: {use,redis,for,caching} vs {use,redis,for,session,caching}
    // Intersection = 4, Union = 5 → Jaccard = 0.8 ≥ 0.8 → dedup
    const state2 = protectedStateMerge({
      prevState: stateWithDecisions(["use Redis for caching"]),
      documents: [],
      deltaCandidates: [
        {
          eventId: "cjk-e3",
          reason: "novel_event",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.3 },
          event: event({
            id: "cjk-e3",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "use Redis for session caching"
          })
        }
      ]
    });
    expect(state2.stableFacts.decisions).toHaveLength(1);
  });

  it("mixed script (CJK + ASCII) produces distinct decisions when content differs", () => {
    // "用 Redis 做缓存" vs "用 PostgreSQL 做主存储"
    // CJK tokens in first: 用(unigram), 做缓,缓存; ASCII: redis
    // CJK tokens in second: 用(unigram), 做主,主存,存储; ASCII: postgresql
    // Intersection = {用} = 1; Union = 8 → Jaccard = 0.125 ≪ 0.8 → both facts survive
    const state2 = protectedStateMerge({
      prevState: stateWithDecisions(["用 Redis 做缓存"]),
      documents: [],
      deltaCandidates: [
        {
          eventId: "cjk-e4",
          reason: "novel_event",
          features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
          event: event({
            id: "cjk-e4",
            scopeId: "sc",
            userId: "u",
            type: "stream",
            content: "用 PostgreSQL 做主存储"
          })
        }
      ]
    });
    expect(state2.stableFacts.decisions).toHaveLength(2);
    expect(state2.stableFacts.decisions).toContain("用 Redis 做缓存");
    expect(state2.stableFacts.decisions).toContain("用 PostgreSQL 做主存储");
  });
});

describe("CJK drift-protection (chunk 1b)", () => {
  // Helper: stream event with optional classifiedType
  function streamEvent(id: string, content: string, classifiedType?: string): MemoryEvent {
    return event({ id, scopeId: "sc", userId: "u", type: "stream", content, classifiedType: classifiedType ?? null });
  }

  // Helper: minimal decision delta candidate
  function decisionDelta(id: string, content: string): import("./digest-control").DeltaCandidate {
    return {
      eventId: id,
      reason: "stable_fact_signal",
      features: { kind: "decision", importanceScore: 0.9, noveltyScore: 0.9 },
      event: streamEvent(id, content)
    };
  }

  it("★ Test 1: 我决定用PostgreSQL then 我决定用MySQL — BOTH survive distinct in decisions and factRegistry", () => {
    // Jaccard("我决定用PostgreSQL", "我决定用MySQL") ≈ 0.6 (shared CJK bigrams 我决,决定,定用)
    // findBestDecisionMatch uses threshold 0.8 → no dedup → both in stableFacts.decisions.
    // asciiContentDiverges: {postgresql} vs {mysql} → disjoint → sameFactCjkAware=false →
    // isInFactRegistry correctly returns false for MySQL, so MySQL gets its own registry entry.
    const pgDecision = "我决定用PostgreSQL";
    const prevState: DigestState = {
      stableFacts: { decisions: [pgDecision], constraints: [] },
      workingNotes: {},
      todos: [],
      volatileContext: [],
      evidenceRefs: [],
      factRegistry: [{
        id: "fact-pg-001",
        content: pgDecision,
        type: "decision",
        confidence: 0.9,
        addedAt: new Date().toISOString(),
        evidenceId: "evt-pg",
        evidenceType: "event"
      }]
    };

    const state = protectedStateMerge({
      prevState,
      documents: [],
      deltaCandidates: [decisionDelta("evt-mysql", "我决定用MySQL")]
    });

    expect(state.stableFacts.decisions).toContain(pgDecision);
    expect(state.stableFacts.decisions).toContain("我决定用MySQL");
    expect(state.stableFacts.decisions).toHaveLength(2);
    // MySQL must get its own factRegistry entry (not blocked by PostgreSQL's entry via B guard)
    const activeRegistry = getActiveFactRegistry(state);
    expect(activeRegistry.some((e) => e.content.includes("MySQL"))).toBe(true);
    expect(activeRegistry.some((e) => e.content.includes("PostgreSQL"))).toBe(true);
  });

  it("Test 2: near-identical CJK+ASCII decisions sharing the same ASCII token → DEDUP", () => {
    // "我们决定用PostgreSQL数据" vs "我们决定用PostgreSQL数据库"
    // Tokens A = {postgresql, 我们,们决,决定,定用,数据} (6)
    // Tokens B = {postgresql, 我们,们决,决定,定用,数据,据库} (7)
    // Intersection = A → 6; Union = B → 7; Jaccard = 6/7 ≈ 0.857 ≥ 0.8 → dedup.
    // asciiContentTokens: both have {postgresql} → NOT disjoint → asciiContentDiverges=false
    // → sameFactCjkAware allows the dedup to proceed.
    const state = protectedStateMerge({
      prevState: {
        stableFacts: { decisions: ["我们决定用PostgreSQL数据"], constraints: [] },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [decisionDelta("evt-2b", "我们决定用PostgreSQL数据库")]
    });

    // Second event matches the first at Jaccard ≈ 0.857 → reaffirm, not add → still 1 decision
    expect(state.stableFacts.decisions).toHaveLength(1);
  });

  it("Test 3: 我对花生过敏 vs 我对海鲜过敏 → distinct (low bigram Jaccard, no ASCII tokens)", () => {
    // Bigrams: {我对,对花,花生,生过,过敏} vs {我对,对海,海鲜,鲜过,过敏}
    // Intersection={我对,过敏}=2; Union=8; Jaccard=0.25 ≪ 0.8 → both survive.
    // Pure CJK → asciiContentDiverges=false (no-op); guard doesn't interfere.
    const state = protectedStateMerge({
      prevState: {
        stableFacts: { decisions: ["我对花生过敏"], constraints: [] },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [decisionDelta("evt-seafood", "我对海鲜过敏")]
    });

    expect(state.stableFacts.decisions).toHaveLength(2);
    expect(state.stableFacts.decisions).toContain("我对花生过敏");
    expect(state.stableFacts.decisions).toContain("我对海鲜过敏");
  });

  it("★ Test 4: CJK identity write-protection — pure-Chinese identity fact in registry survives contradicting stream event", () => {
    // "我在北京字节跳动工作" vs "我在北京字节跳动上班":
    // Bigrams share: 我在,在北,北京,京字,字节,节跳,跳动 (7); Union=11; Jaccard≈0.636 ≥ 0.6
    // → identityFacts.findIndex fires; isIdentityProtected must return true to block override.
    // Before A-fix: isIdentityProtected used normalizeText (strips CJK) → Jaccard("","")=0 → unprotected (BUG)
    // After A-fix: sameFactCjkAware uses raw strings → Jaccard=1 for self-comparison → protected ✓
    const originalFact = "我在北京字节跳动工作";
    const conflictingFact = "我在北京字节跳动上班";

    // Phase 1: stream personal_detail event creates the fact and registers it
    const state1 = protectedStateMerge({
      prevState: null,
      documents: [],
      deltaCandidates: [{
        eventId: "pd-1",
        reason: "novel_event",
        features: { kind: "note", importanceScore: 0.7, noveltyScore: 0.9 },
        event: streamEvent("pd-1", originalFact, "personal_detail")
      }]
    });

    expect(state1.profile?.identity).toContain(originalFact);
    const registry1 = getActiveFactRegistry(state1);
    expect(registry1.some((e) => e.facet === "identity" && e.content === originalFact)).toBe(true);

    // Phase 2: contradicting stream event — must NOT override the write-protected original
    const state2 = protectedStateMerge({
      prevState: state1,
      documents: [],
      deltaCandidates: [{
        eventId: "pd-2",
        reason: "novel_event",
        features: { kind: "note", importanceScore: 0.7, noveltyScore: 0.9 },
        event: streamEvent("pd-2", conflictingFact, "personal_detail")
      }]
    });

    expect(state2.profile?.identity).toContain(originalFact);
    expect(state2.profile?.identity).not.toContain(conflictingFact);
  });

  it("Test 5: English registry / dedup behavior is unchanged (idempotence)", () => {
    // Distinct English payloads stay distinct (low ASCII Jaccard)
    const state1 = protectedStateMerge({
      prevState: {
        stableFacts: { decisions: ["we decided to use Redis for caching"], constraints: [] },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [decisionDelta("eng-1", "we decided to use PostgreSQL as the main database")]
    });
    expect(state1.stableFacts.decisions).toHaveLength(2);

    // Near-identical English payload → dedup (Jaccard ≥ 0.8)
    const state2 = protectedStateMerge({
      prevState: {
        stableFacts: { decisions: ["we decided to use Redis for caching"], constraints: [] },
        workingNotes: {},
        todos: [],
        volatileContext: [],
        evidenceRefs: []
      },
      documents: [],
      deltaCandidates: [decisionDelta("eng-2", "we decided to use Redis for session caching")]
    });
    // Tokens: {decided,use,redis,for,caching} vs {decided,use,redis,for,session,caching}
    // Intersection=5, Union=6, Jaccard=5/6≈0.83 ≥ 0.8 → dedup → 1 decision
    expect(state2.stableFacts.decisions).toHaveLength(1);
  });

  it("Test 6: two different pure-CJK goals do NOT falsely collapse via \"\" === \"\" shortcut", () => {
    // Before fix: normalizeText strips CJK → both goals → "" → "" === "" → sameGoal=true
    //             → document goal "我们的目标是提高销售额" would NOT replace old goal (bug)
    // After fix: normPrev.length === 0 → guard skips === → falls through to jaccardSimilarity
    //            Jaccard("我们的目标是提升用户体验","我们的目标是提高销售额") ≈ 0.4 < 0.85 (doc threshold)
    //            → sameGoal=false → document IS authoritative → goal updated ✓
    const oldGoal = "我们的目标是提升用户体验";
    const newGoal = "我们的目标是提高销售额";

    const prevState: DigestState = {
      stableFacts: { decisions: [], constraints: [], goal: oldGoal },
      workingNotes: {},
      todos: [],
      volatileContext: [],
      evidenceRefs: []
    };

    // Document containing the new goal (document authority → overwriteThreshold=0.85)
    const docEvent = event({
      id: "doc-goal-1",
      scopeId: "sc",
      userId: "u",
      type: "document",
      key: "goal:updated",
      content: `goal: ${newGoal}`
    });

    const state = protectedStateMerge({
      prevState,
      documents: [docEvent],
      deltaCandidates: []
    });

    // The new CJK goal must have replaced the old one (not silently swallowed by "" === "")
    expect(state.stableFacts.goal).toBe(newGoal);
    expect(state.stableFacts.goal).not.toBe(oldGoal);
  });
});
