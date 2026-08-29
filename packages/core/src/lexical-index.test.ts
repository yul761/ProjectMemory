import { describe, it, expect } from "vitest";
import { tokenizeForIndex } from "./lexical-index";

describe("tokenizeForIndex", () => {
  it("lowercases ASCII words and drops short tokens", () => {
    expect(tokenizeForIndex("Use PGVector for DB")).toEqual(["use", "pgvector", "for"]);
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
});
