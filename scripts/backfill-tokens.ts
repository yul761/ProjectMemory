/**
 * Backfill the lexical token index (MemoryEventToken) for events ingested
 * before the index existed. Idempotent: only events with no token rows are
 * touched, so re-running after an interruption picks up where it stopped.
 * The embedded MCP store backfills itself at open; this script is for server
 * deployments, run once after the 20260829120000_memory_event_tokens
 * migration:
 *
 *   pnpm backfill:tokens            # all scopes
 *   pnpm backfill:tokens --scope-id <uuid>
 */
import { prisma } from "@statecore/db";
import { tokenizeForIndex } from "@statecore/core";

function parseArgs(argv: string[]): { scopeId?: string } {
  const result: { scopeId?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--scope-id" && argv[i + 1]) result.scopeId = argv[i + 1];
  }
  return result;
}

const BATCH = 500;

async function main() {
  const { scopeId } = parseArgs(process.argv.slice(2));
  let indexed = 0;
  let sentinels = 0;
  for (;;) {
    const events = await prisma.memoryEvent.findMany({
      where: { ...(scopeId ? { scopeId } : {}), suppressedAt: null, tokens: { none: {} } },
      select: { id: true, scopeId: true, content: true },
      take: BATCH
    });
    if (!events.length) break;
    for (const event of events) {
      const tokens = tokenizeForIndex(event.content);
      if (!tokens.length) {
        // Content with no indexable tokens would be re-selected forever by the
        // `tokens: none` filter; a sentinel empty-string row marks it done.
        await prisma.memoryEventToken.createMany({
          data: [{ eventId: event.id, scopeId: event.scopeId, token: "" }],
          skipDuplicates: true
        });
        sentinels += 1;
        continue;
      }
      await prisma.memoryEventToken.createMany({
        data: tokens.map((token) => ({ eventId: event.id, scopeId: event.scopeId, token })),
        skipDuplicates: true
      });
      indexed += 1;
    }
    console.log(`indexed ${indexed} events so far...`);
  }
  console.log(
    `done: ${indexed} events indexed, ${sentinels} without indexable tokens marked${scopeId ? `, scope ${scopeId}` : ""}`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
