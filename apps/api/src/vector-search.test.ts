import { describe, it, expect, vi } from "vitest";
import { createVectorSearchFn, type RawQueryClient } from "./vector-search";

describe("createVectorSearchFn — tenant scoping", () => {
  it("scopes the query by scopeId and returns event ids", async () => {
    let capturedSql = "";
    let capturedValues: unknown[] = [];
    const fakeClient = {
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        capturedSql = strings.join("?");
        capturedValues = values;
        return Promise.resolve([{ eventId: "e1" }, { eventId: "e2" }]);
      })
    } as RawQueryClient;

    const fn = createVectorSearchFn(fakeClient);
    const result = await fn([0.1, 0.2, 0.3], 10, "scope-123");

    expect(result).toEqual(["e1", "e2"]);
    expect(capturedSql).toContain('"scopeId"');
    expect(capturedSql).toContain('"MemoryEvent"');
    expect(capturedValues).toContain("scope-123");
  });
});
