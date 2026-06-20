import { describe, expect, it } from "vitest";
import { RetrieveService } from "./index";

// tokenize/explainQueryScore are private; construct with nulls (we never call DB paths) and reach in via casts.
function svc() {
  return new RetrieveService(null as any, null as any) as any;
}

describe("RetrieveService CJK tokenization", () => {
  it("emits adjacent bigrams for a Chinese run", () => {
    const tokens: string[] = svc().tokenize("我对花生过敏");
    expect(tokens).toContain("花生");
    expect(tokens).toContain("过敏");
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("recalls a Chinese fact via shared bigrams", () => {
    const { score } = svc().explainQueryScore("我对什么过敏", "我对花生过敏");
    expect(score).toBeGreaterThan(0);
  });

  it("kills the character-count false positive (regression: discussion §12.2)", () => {
    const { score } = svc().explainQueryScore("我喜欢打篮球", "我对花生过敏");
    expect(score).toBe(0);
  });

  it("does not degrade English word tokenization", () => {
    const tokens: string[] = svc().tokenize("I am allergic to peanuts");
    expect(tokens).toContain("allergic");
    expect(tokens).toContain("peanuts");
    expect(tokens).not.toContain("am"); // length > 2 filter still applies to ASCII
  });

  it("handles mixed script", () => {
    const tokens: string[] = svc().tokenize("上传resume");
    expect(tokens).toContain("resume");
    expect(tokens).toContain("上传");
  });

  it("keeps a single CJK character as a unigram", () => {
    const tokens: string[] = svc().tokenize("钱");
    expect(tokens).toContain("钱");
  });

  it("smoke-tests Japanese and Korean bigrams", () => {
    expect(svc().tokenize("ともだち")).toContain("とも"); // hiragana
    expect(svc().tokenize("친구만나다")).toContain("친구"); // hangul
  });
});
