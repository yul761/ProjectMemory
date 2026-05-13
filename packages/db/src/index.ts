import type { PrismaClient } from "@prisma/client";

function createPrismaClient(): PrismaClient {
  if (process.env["STATECORE_MODE"] === "lite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: LiteClient } = require("../generated/client-lite");
    return new LiteClient() as PrismaClient;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: FullClient } = require("@prisma/client");
  return new FullClient();
}

export const prisma = createPrismaClient();
