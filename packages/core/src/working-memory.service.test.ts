import { describe, it, expect, vi } from "vitest";
import { WorkingMemoryService } from "./working-memory.service";
import type { WorkingMemoryRepo, WorkingMemorySnapshot } from "./working-memory.service";
import type { WorkingMemoryEventLike } from "./working-memory.extractor";
import type { WorkingMemoryState } from "./working-memory.extractor";

function makeRepo(latest: WorkingMemorySnapshot | null) {
  const findLatest = vi.fn(async (_scopeId: string): Promise<WorkingMemorySnapshot | null> => latest);
  const upsert = vi.fn(
    async (input: Parameters<WorkingMemoryRepo["upsert"]>[0]): Promise<WorkingMemorySnapshot> => ({
      id: "wm1",
      scopeId: input.scopeId,
      version: input.version,
      state: input.state,
      view: input.view,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    })
  );
  const repo: WorkingMemoryRepo = { findLatest, upsert };
  return { repo, findLatest, upsert };
}

describe("WorkingMemoryService", () => {
  it("getLatest delegates to repo.findLatest", async () => {
    const { repo, findLatest } = makeRepo(null);
    const service = new WorkingMemoryService(repo);
    const result = await service.getLatest("scope-1");
    expect(findLatest).toHaveBeenCalledWith("scope-1");
    expect(result).toBeNull();
  });

  it("updateFromEvents starts at version 1 when there is no previous snapshot", async () => {
    const { repo, upsert } = makeRepo(null);
    const service = new WorkingMemoryService(repo);
    const snapshot = await service.updateFromEvents("scope-1", [], "ship it");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "scope-1", version: 1 })
    );
    expect(snapshot.version).toBe(1);
  });

  it("updateFromEvents applies a refineState option when provided", async () => {
    const { repo, upsert } = makeRepo(null);
    const refineState = vi.fn(
      async (input: {
        scopeId: string;
        events: WorkingMemoryEventLike[];
        previous: WorkingMemorySnapshot | null;
        state: WorkingMemoryState;
      }) => input.state
    );
    const service = new WorkingMemoryService(repo, { refineState });
    await service.updateFromEvents("scope-1", [], null);
    expect(refineState).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
