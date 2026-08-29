import { describe, it, expect } from "vitest";
import { tokenizeForIndex } from "./lexical-index";

describe("tokenizeForIndex", () => {
  it("lowercases ASCII words, drops short tokens and stopwords", () => {
    expect(tokenizeForIndex("Use PGVector for DB")).toEqual(["use", "pgvector"]);
  });

  it("emits CJK adjacent bigrams, keeping a lone char as a unigram", () => {
    expect(tokenizeForIndex("数据库")).toEqual(["数据", "据库"]);
    expect(tokenizeForIndex("库")).toEqual(["库"]);
  });

  it("deduplicates tokens", () => {
    expect(tokenizeForIndex("cache cache cache 数据数据")).toEqual(["cache", "数据", "据数"]);
  });

  it("caps the number of tokens", () => {
    const text = Array.from({ length: 600 }, (_, i) => `token${i}`).join(" ");
    expect(tokenizeForIndex(text).length).toBe(512);
  });

  it("returns empty for empty or symbol-only input", () => {
    expect(tokenizeForIndex("")).toEqual([]);
    expect(tokenizeForIndex("!!! ...")).toEqual([]);
  });

  it("drops English stopwords from the index", () => {
    // Stopwords dominate a match-count ranking ("the and for was" beating
    // "deployment rollback") and make the count query aggregate the largest
    // possible row sets. The scorer keeps them; the index does not.
    expect(tokenizeForIndex("the deployment was rolled back because of the bug")).toEqual([
      "deployment",
      "rolled",
      "back",
      "bug"
    ]);
  });

  it("keeps CJK tokens under the cap when ASCII words would otherwise fill it", () => {
    const ascii = Array.from({ length: 30 }, (_, i) => `token${i}`).join(" ");
    const tokens = tokenizeForIndex(`${ascii} 数据库迁移`, 24);
    expect(tokens.length).toBe(24);
    expect(tokens).toContain("数据");
    expect(tokens).toContain("迁移");
  });
});
