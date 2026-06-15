import { describe, it, expect, vi } from "vitest";

describe("runEmbedEventJob", () => {
  it("embeds event content and upserts vector via raw SQL", async () => {
    const mockEvent = { id: "evt-1", content: "We decide to use Postgres" };
    const mockPrisma = {
      memoryEvent: { findUnique: vi.fn().mockResolvedValue(mockEvent) },
      $executeRaw: vi.fn().mockResolvedValue(1)
    } as any;
    const mockEmbeddingModel = { embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) };

    const { runEmbedEventJob } = await import("./embed-job");
    await runEmbedEventJob(
      { eventId: "evt-1", scopeId: "sc" },
      mockEmbeddingModel,
      mockPrisma,
      "text-embedding-3-small"
    );

    expect(mockEmbeddingModel.embed).toHaveBeenCalledWith(["We decide to use Postgres"]);
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  it("skips silently when event not found", async () => {
    const mockPrisma = {
      memoryEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      $executeRaw: vi.fn()
    } as any;
    const mockEmbeddingModel = { embed: vi.fn() };

    const { runEmbedEventJob } = await import("./embed-job");
    await runEmbedEventJob({ eventId: "missing", scopeId: "sc" }, mockEmbeddingModel, mockPrisma, "model");

    expect(mockEmbeddingModel.embed).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("skips silently when embeddingModel is null", async () => {
    const mockPrisma = {
      memoryEvent: { findUnique: vi.fn() },
      $executeRaw: vi.fn()
    } as any;

    const { runEmbedEventJob } = await import("./embed-job");
    await runEmbedEventJob({ eventId: "evt-1", scopeId: "sc" }, null, mockPrisma, "");

    expect(mockPrisma.memoryEvent.findUnique).not.toHaveBeenCalled();
  });
});
