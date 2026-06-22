import { describe, it, expect } from "vitest";
import { BoundedTtlCache } from "./bounded-ttl-cache";

describe("BoundedTtlCache", () => {
  it("returns a stored value before expiry and undefined after", () => {
    const c = new BoundedTtlCache<number>(1000, 10);
    c.set("a", 1, 0);
    expect(c.get("a", 500)).toBe(1);
    expect(c.get("a", 1000)).toBeUndefined(); // expiresAt is exclusive at ttl boundary
  });

  it("evicts the least-recently-written entry beyond the cap", () => {
    const c = new BoundedTtlCache<number>(10_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("c", 3, 0); // exceeds cap 2 -> oldest ("a") evicted
    expect(c.get("a", 1)).toBeUndefined();
    expect(c.get("b", 1)).toBe(2);
    expect(c.get("c", 1)).toBe(3);
  });

  it("re-writing a key refreshes its recency so it is not the first evicted", () => {
    const c = new BoundedTtlCache<number>(10_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.set("a", 11, 0); // refresh "a" -> "b" is now oldest
    c.set("c", 3, 0);  // evicts "b"
    expect(c.get("a", 1)).toBe(11);
    expect(c.get("b", 1)).toBeUndefined();
    expect(c.get("c", 1)).toBe(3);
  });

  it("purges expired entries on write so the map cannot grow unbounded with stale keys", () => {
    const c = new BoundedTtlCache<number>(1000, 100);
    c.set("old", 1, 0);
    c.set("new", 2, 2000); // 'old' is expired at now=2000 and purged during this set
    expect(c.get("old", 2001)).toBeUndefined();
    expect(c.get("new", 2001)).toBe(2);
  });
});
