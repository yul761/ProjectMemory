import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { PublicV1Contracts } from "@statecore/contracts";
import { createTestApp } from "./setup";

/**
 * `/v1` paths that are served but deliberately not frozen.
 *
 * Empty, and meant to stay that way. An entry here is a statement that a caller
 * can reach a path under the compatibility prefix whose response may change
 * without notice — so it needs a reason someone can disagree with, not a name.
 * Prefer serving an unstable endpoint at its legacy path only.
 */
const UNFROZEN_V1_ROUTES: Record<string, string> = {};

/**
 * The registry describes the frozen surface; this checks the surface against the
 * server.
 *
 * `PublicV1Contracts` drives the snapshot guard, the OpenAPI document and the
 * docs table, and all three see only what it declares. Nothing looked the other
 * way — at the routes Nest actually registered — so a handler dual-mounted at
 * `/v1` without a registry entry was invisible to every check, and the path
 * advertised a compatibility promise the surface did not make. That happened
 * twice: three endpoints joined the subset at contract `1.4.0` and three more at
 * `1.5.0`, both times found by reading the code rather than by a failing test.
 */
describe("the frozen registry and the served /v1 surface agree", () => {
  let app: INestApplication;
  let served: Set<string>;

  beforeAll(async () => {
    app = await createTestApp();

    // Express 4 exposes the router as `_router`, Express 5 as `router`. Reading
    // it is the only way to see what is actually reachable: route metadata on
    // the controllers describes intent, and intent is what already agreed.
    const instance = app.getHttpAdapter().getInstance() as {
      _router?: { stack: unknown[] };
      router?: { stack: unknown[] };
    };
    const router = instance._router ?? instance.router;
    expect(router, "could not read the Express router — this guard sees nothing without it").toBeDefined();

    served = new Set<string>();
    for (const layer of (router as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack) {
      const route = layer.route;
      if (!route?.path?.startsWith("/v1/")) continue;
      for (const [method, enabled] of Object.entries(route.methods)) {
        if (enabled) served.add(`${method.toUpperCase()} ${route.path.slice("/v1".length)}`);
      }
    }
    // A guard that silently enumerates nothing passes forever.
    expect(served.size).toBeGreaterThan(0);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it("freezes every operation it serves under /v1", () => {
    const unregistered = [...served]
      .filter((operation) => !(operation in PublicV1Contracts))
      .filter((operation) => !(operation in UNFROZEN_V1_ROUTES));

    expect(
      unregistered,
      "served under /v1 but absent from PublicV1Contracts: add it to the registry, or to UNFROZEN_V1_ROUTES with a reason"
    ).toEqual([]);
  });

  it("serves every operation it freezes", () => {
    // The opposite fault, equally unguarded: a registry entry with no route
    // behind it publishes an endpoint into the OpenAPI document and the docs
    // table that a caller gets a 404 from.
    const undelivered = Object.keys(PublicV1Contracts).filter((operation) => !served.has(operation));

    expect(undelivered, "frozen in PublicV1Contracts but not served under /v1").toEqual([]);
  });

  it("keeps every exemption explained", () => {
    for (const [operation, reason] of Object.entries(UNFROZEN_V1_ROUTES)) {
      expect(reason.length, `${operation} is exempt without a reason`).toBeGreaterThan(20);
      expect(served.has(operation), `${operation} is exempt but not served`).toBe(true);
    }
  });
});
