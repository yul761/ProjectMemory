import { describe, it, expect } from "vitest";
import { runDigestControlPipeline } from "./digest-control";
import type { MemoryEvent, Digest, ProjectScope } from "./index";

const scope: ProjectScope = {
  id: "s1",
  userId: "u1",
  name: "test",
  goal: null,
  stage: "build",
  template: null,
  createdAt: new Date("2026-01-01T00:00:00Z")
};

const lastDigest: Digest = {
  id: "d1",
  scopeId: "s1",
  summary: "previous",
  changes: "",
  nextSteps: [],
  createdAt: new Date("2026-06-01T00:00:00Z")
};

function doc(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "e1",
    userId: "u1",
    scopeId: "s1",
    type: "document",
    source: "api",
    key: "resume-2026",
    content: "工作经历: 字节跳动 资深后端工程师 2019-2023",
    createdAt: new Date("2026-01-15T00:00:00Z"), // ingested long before the last digest
    updatedAt: null,
    classifiedType: null,
    ...overrides
  };
}

const llm = {
  chat: async () =>
    JSON.stringify({
      summary: "updated",
      changes: ["resume revised"],
      nextSteps: ["none"],
      profileFacts: [{ facet: "identity", value: "工作经历: 字节跳动 资深后端工程师 2019-2023" }]
    })
};

const prompts = { digestStage2SystemPrompt: "system", digestStage2UserPrompt: "{{scopeName}}" };
const config = {
  eventBudgetTotal: 40,
  eventBudgetDocs: 10,
  eventBudgetStream: 30,
  noveltyThreshold: 0.15,
  maxRetries: 1,
  useLlmClassifier: false,
  debug: false
};

describe("re-ingested documents re-trigger the digest", () => {
  it("treats an updated document as new work even though createdAt is unchanged", async () => {
    // A document upsert rewrites content and stamps updatedAt, but keeps the
    // original createdAt. Checking only createdAt meant re-uploading a corrected
    // resume never re-ran the digest: the state kept serving facts extracted from
    // the superseded version, and because identity is write-protected, no later
    // conversation could correct it either.
    const result = await runDigestControlPipeline({
      scope,
      lastDigest,
      recentEvents: [doc({ updatedAt: new Date("2026-07-01T00:00:00Z") })],
      llm,
      prompts,
      config
    });

    expect(result.selection.rationale).not.toContain("no_new_events_since_last_digest");
    expect(result.digest.summary).toBe("updated");
  });

  it("still short-circuits when nothing has been created or updated since", async () => {
    const result = await runDigestControlPipeline({
      scope,
      lastDigest,
      recentEvents: [doc({ updatedAt: new Date("2026-02-01T00:00:00Z") })],
      llm,
      prompts,
      config
    });

    expect(result.selection.rationale).toContain("no_new_events_since_last_digest");
  });

  it("still short-circuits when an event has no updatedAt at all", async () => {
    const result = await runDigestControlPipeline({
      scope,
      lastDigest,
      recentEvents: [doc({ updatedAt: null })],
      llm,
      prompts,
      config
    });

    expect(result.selection.rationale).toContain("no_new_events_since_last_digest");
  });
});
