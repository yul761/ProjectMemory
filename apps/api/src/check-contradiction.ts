import { prisma as defaultPrisma } from "@statecore/db";

export interface ContradictionResult {
  hasContradiction: boolean;
  message: string | null;
}

export async function checkContradiction(
  scopeId: string,
  content: string,
  llm: { chat: (messages: { role: string; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<ContradictionResult> {
  const snapshot = await (db as any).digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "desc" }
  });

  if (!snapshot) return { hasContradiction: false, message: null };

  const stableFacts = (snapshot.state as any)?.stableFacts;
  if (!stableFacts) return { hasContradiction: false, message: null };

  const facts = [
    stableFacts.goal,
    ...(stableFacts.decisions ?? []),
    ...(stableFacts.constraints ?? [])
  ].filter(Boolean).slice(0, 10);

  if (!facts.length) return { hasContradiction: false, message: null };

  try {
    const raw = await llm.chat([
      {
        role: "system",
        content: `You check if a user's request conflicts with their established goals and decisions.
If there is a clear, obvious conflict, return a short natural sentence mentioning the relevant fact — in the same language as the user input.
If no clear conflict or you are uncertain, return no contradiction.
Be gentle, not accusatory.
Return JSON: { "hasContradiction": boolean, "message": string | null }`
      },
      {
        role: "user",
        content: `Established facts:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nUser input: ${content}`
      }
    ]);

    const parsed = JSON.parse(raw) as { hasContradiction?: boolean; message?: string | null };
    return {
      hasContradiction: parsed.hasContradiction === true,
      message: parsed.hasContradiction === true ? (parsed.message ?? null) : null
    };
  } catch {
    return { hasContradiction: false, message: null };
  }
}
