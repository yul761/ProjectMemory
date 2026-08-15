// statecore-mcp/lib is the reuse surface a dsh-statecore native plugin
// consumes as a library instead of talking to the MCP server over stdio:
// createEmbeddedBackend/createHttpBackend/resolveScopeName re-exported
// unchanged, plus runScopeDigest — a digest entry point that runs against an
// injected chat model instead of one built from FEATURE_LLM/MODEL_* env vars.
// This test drives the export surface itself (`../src/lib`, not the
// individual modules), the injected-llm threading through
// createEmbeddedBackend's opts.digestLlm, and the direct runScopeDigest
// contract; the last test confirms the pre-existing keyless/keyed env
// behavior is unchanged when no llm is injected.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedBackend, runScopeDigest, type DigestChatModel } from "../src/lib";
import { openStore } from "../src/store";

const USER = "local";

/** A minimal DigestOutputSchema-valid stage-2 response (packages/core/src/digest-control.ts),
 * copied from tests/digest-keyed.test.ts's STAGE2_OUTPUT: `summary`/`changes`/`nextSteps` are
 * required, `nextSteps` must have 1-3 items, `changes` at most 3. `profileFacts: []` keeps the
 * run to a single llm.chat call. */
const STAGE2_OUTPUT = {
  summary: "The scope received a burst of stream events during the lib-export test.",
  changes: ["Recorded several new stream events."],
  nextSteps: ["Continue monitoring incoming events."],
  profileFacts: []
};

function makeStubLlm(): { llm: DigestChatModel; callCount: () => number } {
  let calls = 0;
  return {
    llm: {
      chat: async () => {
        calls += 1;
        return JSON.stringify(STAGE2_OUTPUT);
      }
    },
    callCount: () => calls
  };
}

describe("statecore-mcp/lib export surface", () => {
  it("runScopeDigest: runs one locked digest attempt against an injected llm and persists the result", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sc-mcp-lib-runscope-"));
    const store = await openStore(dataDir);
    try {
      await store.prisma.user.upsert({ where: { identity: USER }, update: {}, create: { id: USER, identity: USER } });
      const scope = await store.prisma.projectScope.create({ data: { userId: USER, name: "lib-runscope-test", template: "project" } });
      for (let i = 0; i < 3; i += 1) {
        await store.prisma.memoryEvent.create({
          data: { userId: USER, scopeId: scope.id, type: "stream", source: "api", content: `stream event ${i}` }
        });
      }

      const { llm, callCount } = makeStubLlm();
      await runScopeDigest({ prisma: store.prisma, userId: USER, scopeId: scope.id, llm });

      expect(callCount()).toBe(1);
      const digestRow = await store.prisma.digest.findFirst({ where: { scopeId: scope.id } });
      expect(digestRow?.summary).toBe(STAGE2_OUTPUT.summary);

      const lockRows = await store.prisma.$queryRawUnsafe<Array<{ scopeId: string }>>(
        `SELECT "scopeId" FROM "DigestLock" WHERE "scopeId" = ?`,
        scope.id
      );
      expect(lockRows).toHaveLength(0); // released, not left held
    } finally {
      await store.close();
    }
  });

  it("createEmbeddedBackend({ digestLlm }): a consolidate-remember crossing threshold drives the injected llm and persists a digest", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sc-mcp-lib-embedded-llm-"));
    const { llm, callCount } = makeStubLlm();
    const threshold = 3;
    const backend = createEmbeddedBackend({
      dataDir,
      scopeName: "/tmp/lib-export-llm-project",
      // No FEATURE_LLM/MODEL_API_KEY: digestLlm alone must be enough to skip
      // the env gate and drive the pipeline.
      env: { STATECORE_DIGEST_THRESHOLD: String(threshold) } as unknown as NodeJS.ProcessEnv,
      digestLlm: llm
    });
    try {
      await backend.init();
      for (let i = 0; i < threshold + 1; i += 1) {
        await backend.remember({ text: `stream event ${i}`, consolidate: true });
      }

      await vi.waitFor(() => expect(callCount()).toBeGreaterThan(0), { timeout: 2000, interval: 20 });

      const store = await openStore(dataDir);
      try {
        const digestRow = await store.prisma.digest.findFirst({ orderBy: { createdAt: "desc" } });
        expect(digestRow?.summary).toBe(STAGE2_OUTPUT.summary);
      } finally {
        await store.close();
      }
    } finally {
      await backend.close();
    }
  });

  it("createEmbeddedBackend without digestLlm and without a key: consolidate-remember still resolves, no-ops keyless (env path unchanged)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sc-mcp-lib-embedded-noop-"));
    const backend = createEmbeddedBackend({
      dataDir,
      scopeName: "/tmp/lib-export-noop-project",
      env: {} as NodeJS.ProcessEnv
      // No digestLlm.
    });
    try {
      await backend.init();
      const res = await backend.remember({ text: "some stream event", consolidate: true });
      expect(res).toEqual({ ok: true, mode: "event" });

      // The FEATURE_LLM/api-key gate runs synchronously before maybeRunDigest's
      // first await, so by the time remember() (which fires it with `void`,
      // not awaited) has returned, the no-op path has already run to
      // completion — no digest row exists, deterministically, with no wait.
      const store = await openStore(dataDir);
      try {
        const digestRow = await store.prisma.digest.findFirst();
        expect(digestRow).toBeNull();
      } finally {
        await store.close();
      }
    } finally {
      await backend.close();
    }
  });
});
