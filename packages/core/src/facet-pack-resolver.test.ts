import { describe, it, expect, beforeEach } from "vitest";
import { resolveFacetPack, clearFacetPackCache } from "./facet-pack-resolver";
import { getDefaultFacetPack, type FacetPack } from "./facet-registry";

const LEGAL: FacetPack = {
  name: "legal",
  facets: [{ name: "matter", cap: 100, writeProtected: true, displayGroup: "Matters", description: "case matters" }]
};

function store(value: unknown | null, onCall?: () => void) {
  return {
    findFacetPack: async () => {
      onCall?.();
      return value;
    }
  };
}

beforeEach(() => clearFacetPackCache());

describe("resolveFacetPack", () => {
  it("returns the tenant's stored pack", async () => {
    const pack = await resolveFacetPack(store(LEGAL), "u1");
    expect(pack.name).toBe("legal");
    expect(pack.facets[0].name).toBe("matter");
  });

  it("falls back to the default when the tenant has none", async () => {
    const pack = await resolveFacetPack(store(null), "u2");
    expect(pack.name).toBe(getDefaultFacetPack().name);
  });

  it("falls back to the default when the stored pack is malformed", async () => {
    const pack = await resolveFacetPack(store({ name: "broken", facets: "not-an-array" }), "u3");
    expect(pack.name).toBe(getDefaultFacetPack().name);
  });

  it("falls back to the default when the lookup throws, without propagating", async () => {
    const throwing = {
      findFacetPack: async () => {
        throw new Error("db down");
      }
    };
    const pack = await resolveFacetPack(throwing, "u4");
    expect(pack.name).toBe(getDefaultFacetPack().name);
  });

  it("caches within the TTL and re-reads after it expires", async () => {
    let calls = 0;
    const s = store(LEGAL, () => calls++);
    let clock = 1_000;
    const now = () => clock;

    await resolveFacetPack(s, "u5", now);
    await resolveFacetPack(s, "u5", now);
    expect(calls).toBe(1);

    clock += 61_000;
    await resolveFacetPack(s, "u5", now);
    expect(calls).toBe(2);
  });

  it("does not let one tenant's pack leak into another", async () => {
    const a = await resolveFacetPack(store(LEGAL), "tenant-a");
    const b = await resolveFacetPack(store(null), "tenant-b");
    expect(a.name).toBe("legal");
    expect(b.name).toBe(getDefaultFacetPack().name);
  });

  it("clearFacetPackCache makes a newly installed pack take effect", async () => {
    await resolveFacetPack(store(null), "u6");
    clearFacetPackCache("u6");
    const pack = await resolveFacetPack(store(LEGAL), "u6");
    expect(pack.name).toBe("legal");
  });
});
