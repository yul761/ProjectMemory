import { describe, it, expect } from "vitest";
import { selectDigestEventWindow } from "./digest-lookback";

const NOW = new Date("2026-08-06T00:00:00Z");

describe("which events a digest run considers", () => {
  it("includes an event that happened long ago but was ingested just now", () => {
    // The defect this covers: `occurredAt` backdates an event's createdAt to when
    // the conversation actually happened, and the digest's lookback then filtered
    // on that same column. Importing two years of history produced a digest that
    // reported success and selected nothing — `selected_stream:0` — so the fact
    // layer stayed empty with no error anywhere.
    const where = selectDigestEventWindow({ scopeId: "s1", lookbackDays: 14, now: NOW });

    expect(where.OR).toBeDefined();
    const clauses = JSON.stringify(where.OR);
    expect(clauses).toContain("ingestedAt");
  });

  it("still bounds the window, so a digest does not reprocess all history", () => {
    const where = selectDigestEventWindow({ scopeId: "s1", lookbackDays: 14, now: NOW });
    const cutoff = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
    expect(JSON.stringify(where.OR)).toContain(cutoff);
  });

  it("keeps the scope and suppression filters", () => {
    const where = selectDigestEventWindow({ scopeId: "s1", lookbackDays: 14, now: NOW });
    expect(where.scopeId).toBe("s1");
    expect(where.suppressedAt).toBeNull();
  });

  it("treats a zero or negative lookback as unbounded rather than as 'nothing'", () => {
    // A misconfigured lookback should not silently mean an empty digest.
    const where = selectDigestEventWindow({ scopeId: "s1", lookbackDays: 0, now: NOW });
    expect(where.OR).toBeUndefined();
  });
});
