import { describe, it, expect } from "vitest";
import {
  applyProfileFactsFromDigest,
  getActiveFactRegistry,
  type DigestState,
  type FactRegistryEntry
} from "./digest-control";
import type { MemoryEvent } from "./index";

const NOW = () => "2026-08-05T00:00:00.000Z";

function doc(id = "doc-1"): MemoryEvent {
  return {
    id,
    userId: "u1",
    scopeId: "s1",
    type: "document",
    source: "api",
    key: "resume-2026",
    content: "resume",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    classifiedType: null
  };
}

/** State as it looks after a resume has been ingested: identity facts at document authority. */
function stateWithResumeFact(content = "工作经历: 字节跳动 后端工程师 2019-2022"): DigestState {
  const entry: FactRegistryEntry = {
    id: "f-doc",
    content,
    type: "profile",
    confidence: 0.85, // document authority
    addedAt: "2026-01-01T00:00:00.000Z",
    evidenceId: "doc-1",
    evidenceType: "document",
    facet: "identity"
  };
  return {
    stableFacts: {},
    factRegistry: [entry],
    profile: { identity: [content] }
  } as unknown as DigestState;
}

describe("write protection on the stage-2 path", () => {
  it("a conversational fact must not overwrite a document-authored protected fact", () => {
    const state = stateWithResumeFact();
    const streamEvidence = { id: "evt-9", sourceType: "event" as const };

    // The digest LLM extracted a contradictory identity fact from chat.
    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "工作经历: 某小公司 初级工程师 2019-2022" }],
      [], // no documents in this run
      streamEvidence,
      () => "f-stream",
      NOW
    );

    const active = getActiveFactRegistry(state);
    const identity = active.filter((e) => e.facet === "identity");

    // The document-authored fact must still be the active one.
    expect(identity.map((e) => e.content)).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
    expect(state.profile?.identity).toContain("工作经历: 字节跳动 后端工程师 2019-2022");
  });

  it("a document-authored fact may still supersede the previous document fact", () => {
    const state = stateWithResumeFact();

    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "工作经历: 字节跳动 资深后端工程师 2019-2023" }],
      [doc("doc-2")], // a document IS present, so this is document authority
      null,
      () => "f-doc-2",
      NOW
    );

    const active = getActiveFactRegistry(state).filter((e) => e.facet === "identity");
    expect(active.map((e) => e.content)).toContain("工作经历: 字节跳动 资深后端工程师 2019-2023");
    expect(state.factRegistry!.find((e) => e.id === "f-doc")!.supersededBy).toBeDefined();
  });

  it("an unprotected facet is still freely updated by conversation", () => {
    const state = {
      stableFacts: {},
      factRegistry: [
        {
          id: "f-style",
          content: "偏好冗长的回答",
          type: "profile" as const,
          confidence: 0.6,
          addedAt: "2026-01-01T00:00:00.000Z",
          evidenceId: "evt-1",
          evidenceType: "event" as const,
          facet: "style"
        }
      ],
      profile: { style: ["偏好冗长的回答"] }
    } as unknown as DigestState;

    applyProfileFactsFromDigest(
      state,
      [{ facet: "style", value: "偏好简洁的回答" }],
      [],
      { id: "evt-2", sourceType: "event" },
      () => "f-style-2",
      NOW
    );

    expect(state.profile?.style).toContain("偏好简洁的回答");
  });
});

describe("write protection under a near-duplicate conversational claim", () => {
  it("does not let a 0.6-authority chat fact supersede a 0.85-authority document fact", () => {
    const state = stateWithResumeFact();

    // Near-duplicate: only the job title differs, so this matches the existing
    // fact and takes the *update* path rather than the add path.
    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "工作经历: 字节跳动 初级工程师 2019-2022" }],
      [],
      { id: "evt-9", sourceType: "event" },
      () => "f-stream",
      NOW
    );

    const original = state.factRegistry!.find((e) => e.id === "f-doc")!;
    expect(original.supersededBy).toBeUndefined();
    expect(state.profile?.identity).toEqual(["工作经历: 字节跳动 后端工程师 2019-2022"]);
  });

  it("does not accumulate a contradictory second fact in a protected facet", () => {
    const state = stateWithResumeFact();

    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "工作经历: 某小公司 初级工程师 2019-2022" }],
      [],
      { id: "evt-9", sourceType: "event" },
      () => "f-stream",
      NOW
    );

    // A protected facet holding two contradictory employment histories is drift
    // by accumulation: retrieval surfaces both and the answerer picks one.
    expect(state.profile?.identity).toHaveLength(1);
  });
});

describe("rejections are recorded, never silent", () => {
  it("records protected_lower_authority when chat loses to a higher-authority fact", () => {
    // goals is write-protected but NOT document-authority, so it is the facet
    // where the authority comparison actually decides the outcome. (For identity
    // the document-evidence guard fires first.)
    const state = {
      stableFacts: {},
      factRegistry: [
        {
          id: "f-goal",
          content: "目标: 7 月上线 Remi",
          type: "profile" as const,
          confidence: 0.85,
          addedAt: "2026-01-01T00:00:00.000Z",
          evidenceId: "doc-1",
          evidenceType: "document" as const,
          facet: "goals"
        }
      ],
      profile: { goals: ["目标: 7 月上线 Remi"] }
    } as unknown as DigestState;
    const dropLog: import("./drop-log").DropRecord[] = [];

    applyProfileFactsFromDigest(
      state,
      [{ facet: "goals", value: "目标: 9 月上线 Remi" }],
      [],
      { id: "evt-9", sourceType: "event" },
      () => "f-stream",
      NOW,
      dropLog
    );

    const drop = dropLog.find((d) => d.reason === "protected_lower_authority");
    expect(drop).toBeDefined();
    expect(drop!.detail).toMatchObject({ facet: "goals", incomingAuthority: 0.6, existingAuthority: 0.85 });
    expect(state.profile?.goals).toEqual(["目标: 7 月上线 Remi"]);
  });

  it("records no_document_evidence when a document-authority facet has no document", () => {
    const state = { stableFacts: {}, factRegistry: [], profile: {} } as unknown as DigestState;
    const dropLog: import("./drop-log").DropRecord[] = [];

    applyProfileFactsFromDigest(
      state,
      [{ facet: "identity", value: "技能: 日语 N1" }],
      [],
      { id: "evt-9", sourceType: "event" },
      () => "f1",
      NOW,
      dropLog
    );

    expect(dropLog.some((d) => d.reason === "no_document_evidence")).toBe(true);
    // And nothing was written to the profile without a registry record behind it.
    expect(state.profile?.identity).toBeUndefined();
  });
});
