// The keyed digest pipeline (digest.ts#runDigestPipeline, ~105 lines mirroring
// apps/worker's stage 1/2 + consolidation orchestration) was previously only
// type-checked — no test ever drove an LLM call through it, and its failures
// are caught and logged to stderr, so a lite-schema/field mismatch would
// present as "distillation silently never happens" (final-review.md
// Important 5). This test runs the real pipeline against a stub OpenAI-style
// endpoint and asserts the persisted output, closing that hole.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRunDigest } from "../src/digest";
import { openStore, type Store } from "../src/store";

const USER = "local";
const THRESHOLD = 5;

/** A minimal DigestOutputSchema-valid stage-2 response (packages/core/src/digest-control.ts):
 * `summary`/`changes`/`nextSteps` are required, `nextSteps` must have 1-3 items,
 * `changes` at most 3. `profileFacts: []` keeps the run to a single LLM call —
 * a non-empty `profileFacts` would additionally trigger consolidateChangedFacets,
 * which is out of scope for this test (see digest-control.ts:2990-3009). */
const STAGE2_OUTPUT = {
  summary: "The scope received a burst of stream events during the keyed digest test.",
  changes: ["Recorded several new stream events."],
  nextSteps: ["Continue monitoring incoming events."],
  profileFacts: []
};

/** Starts a stub `/v1/chat/completions` endpoint on 127.0.0.1 that answers any
 * POST with a fixed OpenAI-style completion whose message content is
 * `STAGE2_OUTPUT`'s strict JSON — enough for model-provider.ts#LlmClient to
 * extract via `choices[0].message.content` and for digest-control.ts's
 * `DigestOutputSchema` to accept. */
function startStubModelServer(): { server: Server; requestCount: () => number } {
  let requestCount = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(STAGE2_OUTPUT) } }] }));
    });
  });
  return { server, requestCount: () => requestCount };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("keyed digest pipeline, driven end to end against a stub model endpoint", () => {
  let dataDir: string;
  let store: Store;
  let server: Server;
  let port: number;
  let getRequestCount: () => number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "sc-mcp-digest-keyed-"));
    store = await openStore(dataDir);
    ({ server, requestCount: getRequestCount } = startStubModelServer());
    port = await listen(server);
  });

  afterEach(async () => {
    await store.close();
    await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs a real keyed digest, persists the digest + snapshot + selection log, and releases the lock", async () => {
    await store.prisma.user.upsert({ where: { identity: USER }, update: {}, create: { id: USER, identity: USER } });
    const scope = await store.prisma.projectScope.create({
      data: { userId: USER, name: "digest-keyed-test", template: "project" }
    });
    const scopeId = scope.id;

    // Seed more stream events than the threshold so maybeRunDigest's
    // reason:"threshold" path fires.
    for (let i = 0; i < THRESHOLD + 1; i += 1) {
      await store.prisma.memoryEvent.create({
        data: { userId: USER, scopeId, type: "stream", source: "api", content: `stream event ${i}` }
      });
    }

    await maybeRunDigest({
      prisma: store.prisma,
      userId: USER,
      scopeId,
      env: {
        FEATURE_LLM: "true",
        MODEL_API_KEY: "test",
        // Not api.openai.com, so the stub's presence-only key check (any
        // non-empty MODEL_API_KEY) is all that's demanded.
        MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
        MODEL_NAME: "stub",
        STATECORE_DIGEST_THRESHOLD: String(THRESHOLD)
        // DIGEST_USE_LLM_CLASSIFIER has no env override — digest.ts's
        // DIGEST_CONFIG hardcodes useLlmClassifier: false, so the classifier
        // path never engages and this stub never needs to answer it.
      } as unknown as NodeJS.ProcessEnv,
      reason: "threshold"
    });

    expect(getRequestCount()).toBe(1);

    const digestRow = await store.prisma.digest.findFirst({ where: { scopeId } });
    expect(digestRow).toBeTruthy();
    expect(digestRow!.summary).toBe(STAGE2_OUTPUT.summary);
    expect(digestRow!.selectionLog).not.toBeNull();

    const snapshot = await store.prisma.digestStateSnapshot.findFirst({ where: { scopeId } });
    expect(snapshot).toBeTruthy();
    expect(snapshot!.digestId).toBe(digestRow!.id);

    const lockRows = await store.prisma.$queryRawUnsafe<Array<{ scopeId: string }>>(
      `SELECT "scopeId" FROM "DigestLock" WHERE "scopeId" = ?`,
      scopeId
    );
    expect(lockRows).toHaveLength(0);
  });
});
