import { describe, it, expect, vi } from "vitest";
import type { DigestState } from "@statecore/core";
import { MemoryFactsService } from "./memory-facts.service";
import { makeMockPrisma } from "./test-support/mock-prisma";

const baseState = (): DigestState => ({
  stableFacts: { decisions: [] },
  workingNotes: {},
  todos: [],
  factRegistry: [],
  profile: {}
});

describe("MemoryFactsService.addNote", () => {
  it("with existing snapshot: updates snapshot and persists the note text", async () => {
    const existingState = baseState();
    const updateMock = vi.fn().mockResolvedValue({});
    const mockPrisma = makeMockPrisma({
      digestStateSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ id: "s1", state: existingState }),
        update: updateMock
      }
    });

    const service = new MemoryFactsService(mockPrisma);
    const result = await service.addNote("user-1", "scope-1", "Remember to check the API limits");

    expect(result).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledOnce();

    const updatedState = updateMock.mock.calls[0][0].data.state;
    expect(updatedState.profile?.notes).toBeDefined();
    expect(updatedState.profile.notes).toContain("Remember to check the API limits");
  });

  it("with existing snapshot: also surfaces note in getFacts as Notes group", async () => {
    const existingState = baseState();
    const capturedState = { current: existingState };
    const updateMock = vi.fn().mockImplementation(async (args: any) => {
      capturedState.current = args.data.state;
    });
    const mockPrisma = makeMockPrisma({
      digestStateSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ id: "s1", state: existingState }),
        update: updateMock
      }
    });

    const service = new MemoryFactsService(mockPrisma);
    await service.addNote("user-1", "scope-1", "Deploy to prod on Friday");

    // Now simulate getFacts on the updated state
    const getFacstPrisma = makeMockPrisma({
      digestStateSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ state: capturedState.current })
      },
      forgottenFact: { findMany: vi.fn().mockResolvedValue([]) }
    });
    const service2 = new MemoryFactsService(getFacstPrisma);
    const groups = await service2.getFacts("scope-1", "user-1");

    const notesGroup = groups.find((g) => g.group === "Notes");
    expect(notesGroup).toBeDefined();
    expect(notesGroup!.items.map((i) => i.text)).toContain("Deploy to prod on Friday");
  });

  it("idempotency: calling addNote twice with same text does not duplicate", async () => {
    const state = baseState();
    // Track updates so second call sees updated state
    const updateMock = vi.fn().mockImplementation(async (args: any) => {
      Object.assign(state, args.data.state);
    });
    const findFirstMock = vi.fn()
      .mockResolvedValueOnce({ id: "s1", state: state })
      .mockResolvedValueOnce({ id: "s1", state: state });

    const mockPrisma = makeMockPrisma({
      digestStateSnapshot: {
        findFirst: findFirstMock,
        update: updateMock
      }
    });

    const service = new MemoryFactsService(mockPrisma);
    await service.addNote("user-1", "scope-1", "API keys rotate every 90 days");
    await service.addNote("user-1", "scope-1", "API keys rotate every 90 days");

    // update should only be called once (second call is idempotent, addNoteFact returns false)
    expect(updateMock).toHaveBeenCalledOnce();
    // Notes array should have exactly 1 entry
    expect(state.profile?.notes?.length).toBe(1);
  });

  it("no-snapshot path: creates a digest + snapshot via $transaction with the note", async () => {
    const txMock = vi.fn().mockImplementation(async (fn: any) => {
      const tx = {
        digest: {
          create: vi.fn().mockResolvedValue({ id: "digest-1" })
        },
        digestStateSnapshot: {
          create: vi.fn().mockResolvedValue({})
        }
      };
      await fn(tx);
      return { tx };
    });
    const mockPrisma = makeMockPrisma({
      digestStateSnapshot: {
        findFirst: vi.fn().mockResolvedValue(null)
      },
      $transaction: txMock
    });

    const service = new MemoryFactsService(mockPrisma);
    const result = await service.addNote("user-1", "scope-new", "First note ever");

    expect(result).toEqual({ ok: true });
    expect(txMock).toHaveBeenCalledOnce();

    // Introspect transaction calls
    const txFn = txMock.mock.calls[0][0];
    const digestCreate = vi.fn().mockResolvedValue({ id: "digest-1" });
    const snapshotCreate = vi.fn().mockResolvedValue({});
    await txFn({ digest: { create: digestCreate }, digestStateSnapshot: { create: snapshotCreate } });

    expect(digestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scopeId: "scope-new", summary: "Notes" }) })
    );

    const snapshotData = snapshotCreate.mock.calls[0][0].data;
    expect(snapshotData.state?.profile?.notes).toContain("First note ever");
  });
});
