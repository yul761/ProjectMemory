import { describe, it, expect } from "vitest";
import { recordDrop, type DropRecord } from "./drop-log";

describe("drop-log", () => {
  it("records a drop with reason and detail", () => {
    const log: DropRecord[] = [];
    recordDrop(log, "facet_not_registered", { facet: "legal_matter", value: "案件 A 已结案" });
    expect(log).toEqual([
      { reason: "facet_not_registered", detail: { facet: "legal_matter", value: "案件 A 已结案" } }
    ]);
  });

  it("truncates long values to 200 chars so the log cannot blow up state size", () => {
    const log: DropRecord[] = [];
    recordDrop(log, "cap_evicted", { facet: "notes", value: "x".repeat(500) });
    expect((log[0].detail as { value: string }).value).toHaveLength(200);
  });

  it("leaves non-string detail values untouched", () => {
    const log: DropRecord[] = [];
    recordDrop(log, "cap_rejected_incoming", { facet: "identity", cap: 15 });
    expect(log[0].detail).toEqual({ facet: "identity", cap: 15 });
  });
});
