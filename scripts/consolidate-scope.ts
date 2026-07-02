import { prisma } from "@statecore/db";
import { createModelProvider, consolidateAllProfileFacets, type DigestState } from "@statecore/core";
import { consolidateFacetSystemPrompt, consolidateFacetUserPrompt } from "@statecore/prompts";
import { workerEnv } from "../apps/worker/src/env";
import { createDigestWithSnapshot } from "../apps/worker/src/digest-write";

type Args = {
  scopeId?: string;
  userId?: string;
};

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--scope-id" && next) {
      result.scopeId = next;
      i += 1;
      continue;
    }
    if (arg === "--user-id" && next) {
      result.userId = next;
      i += 1;
      continue;
    }
  }
  return result;
}

async function resolveScopeId(args: Args) {
  if (args.scopeId) {
    return args.scopeId;
  }

  const userId = args.userId || process.env.BENCH_USER_ID || process.env.STATECORE_CLI_USER_ID || "benchmark-user";
  const state = await prisma.userState.findUnique({ where: { userId } });
  if (state?.activeProjectId) {
    return state.activeProjectId;
  }

  const latestScope = await prisma.projectScope.findFirst({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  if (latestScope?.id) {
    return latestScope.id;
  }

  const globalLatestScope = await prisma.projectScope.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  return globalLatestScope?.id ?? null;
}

async function main() {
  if (!workerEnv.featureLlm) {
    throw new Error("FEATURE_LLM must be true");
  }

  const provider = createModelProvider({
    provider: workerEnv.modelProvider,
    apiKey: workerEnv.modelApiKey,
    baseUrl: workerEnv.modelBaseUrl,
    model: workerEnv.modelName,
    chatApiKey: workerEnv.chatModelApiKey,
    chatBaseUrl: workerEnv.chatModelBaseUrl,
    chatModel: workerEnv.chatModelName,
    structuredOutputApiKey: workerEnv.structuredOutputModelApiKey,
    structuredOutputBaseUrl: workerEnv.structuredOutputModelBaseUrl,
    structuredOutputModel: workerEnv.structuredOutputModelName,
    embeddingApiKey: workerEnv.embeddingModelApiKey,
    embeddingBaseUrl: workerEnv.embeddingModelBaseUrl,
    embeddingModel: workerEnv.embeddingModelName || undefined,
    timeoutMs: workerEnv.modelTimeoutMs
  });
  const llm = provider?.structuredOutput ?? null;
  if (!llm) {
    throw new Error("Structured-output model is not configured");
  }
  const digestLlm = {
    chat: async (messages: { role: "system" | "user"; content: string }[]) =>
      llm.chat(messages, {
        ...(typeof workerEnv.structuredOutputMaxOutputTokens === "number"
          ? { maxOutputTokens: workerEnv.structuredOutputMaxOutputTokens }
          : {}),
        ...(workerEnv.structuredOutputReasoningEffort
          ? { reasoningEffort: workerEnv.structuredOutputReasoningEffort }
          : {})
      })
  };

  const args = parseArgs(process.argv.slice(2));
  const scopeId = await resolveScopeId(args);
  if (!scopeId) {
    throw new Error("Could not resolve scope. Pass --scope-id or --user-id.");
  }

  const scope = await prisma.projectScope.findFirst({ where: { id: scopeId } });
  if (!scope) {
    throw new Error(`Scope not found: ${scopeId}`);
  }

  const lastStateRow = await prisma.digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  if (!lastStateRow) {
    // eslint-disable-next-line no-console
    console.error("no snapshot for scope");
    process.exit(1);
  }

  const state = lastStateRow.state as unknown as DigestState;

  const changed = await consolidateAllProfileFacets({
    state,
    llm: { chat: (messages) => digestLlm.chat(messages) },
    prompts: { systemPrompt: consolidateFacetSystemPrompt, userPromptTemplate: consolidateFacetUserPrompt },
    makeId: () => `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    makeNow: () => new Date().toISOString()
  });
  // eslint-disable-next-line no-console
  console.log("consolidated facets:", changed);

  // Persist a fresh snapshot. DigestStateSnapshot.digestId is @unique → must create a
  // companion Digest row; createDigestWithSnapshot does both in one transaction.
  const lastDigest = await prisma.digest.findFirst({ where: { scopeId: scope.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  await createDigestWithSnapshot(prisma, {
    scopeId: scope.id,
    summary: lastDigest?.summary ?? "(consolidation)",
    changes: "- profile facets consolidated",
    nextSteps: lastDigest?.nextSteps ?? [],
    state,
    consistency: { ok: true, errors: [], warnings: ["facet_consolidation"] }
  });
  // eslint-disable-next-line no-console
  console.log("snapshot written");
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
