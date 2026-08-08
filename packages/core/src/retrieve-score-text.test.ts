import { describe, it, expect } from "vitest";
import { RetrieveService } from "./index";

// The packer needs a relevance score for facts, but the scorer lives as a
// private method on the service. Exposing one narrow public method is smaller
// than duplicating the tokenizer and its alias table into a second place, where
// the two would drift apart.
describe("RetrieveService.scoreText", () => {
  const service = new RetrieveService({} as never, {} as never, {} as never);

  it("scores a matching text above a non-matching one", () => {
    const hit = service.scoreText("trail camera", "Researching a trail camera, solar capable");
    const miss = service.scoreText("trail camera", "Prefers oat milk in coffee");
    expect(hit).toBeGreaterThan(miss);
  });

  it("returns a finite number for an empty query rather than throwing", () => {
    expect(Number.isFinite(service.scoreText("", "anything"))).toBe(true);
  });
});
