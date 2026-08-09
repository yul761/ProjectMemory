import { vi } from "vitest";

/**
 * A Prisma double carrying the reads MemoryFactsService makes on every call,
 * whatever is being tested.
 *
 * `packFor` resolves the tenant's facet pack before it can group or add a fact,
 * so `projectScope.findUnique` and `user.findUnique` are load-bearing for
 * methods that have nothing to do with facet packs. When that resolution was
 * introduced, eight hand-rolled mocks across two files kept the shape they had
 * before it existed and began throwing `Cannot read properties of undefined
 * (reading 'findUnique')`: the service under test grew a dependency and its
 * doubles did not.
 *
 * `template` is a named argument rather than a hidden default because the pack
 * it selects decides how facts group — `personal` maps goals to "Projects" and
 * relationships to "People"; `project` defines neither and returns nothing for
 * the same fixture. A test asserting group names is asserting about a pack, so
 * it should have to name one.
 *
 * Deliberately partial and typed `any` — the point is to supply three tables
 * instead of forty.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeMockPrisma(
  overrides: Record<string, unknown> = {},
  { template = "project" }: { template?: string } = {}
): any {
  return {
    projectScope: { findUnique: vi.fn().mockResolvedValue({ template }) },
    user: { findUnique: vi.fn().mockResolvedValue({ facetPack: null }) },
    ...overrides
  };
}
