import type { NextFunction, Response } from "express";
import { prisma } from "@project-memory/db";
import type { RequestWithUser } from "./types";
import { apiEnv } from "./env";

async function getOrCreateUserByIdentity(identity: string, telegramUserId?: string) {
  return prisma.user.upsert({
    where: { identity },
    update: telegramUserId ? { telegramUserId } : {},
    create: { identity, telegramUserId }
  });
}

export async function authMiddleware(req: RequestWithUser, res: Response, next: NextFunction) {
  if (req.path === "/health") {
    return next();
  }

  const telegramUserId = req.header("x-telegram-user-id");
  const userIdToken = req.header("x-user-id");

  try {
    if (telegramUserId) {
      const user = await getOrCreateUserByIdentity(`telegram:${telegramUserId}`, telegramUserId);
      req.userId = user.id;
      return next();
    }

    if (userIdToken) {
      const identity = userIdToken === apiEnv.localUserToken ? `local:${userIdToken}` : `user:${userIdToken}`;
      const user = await getOrCreateUserByIdentity(identity);
      req.userId = user.id;
      return next();
    }

    return res.status(401).json({ error: "Missing user identity header" });
  } catch {
    return res.status(500).json({ error: "Auth failed" });
  }
}
