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
