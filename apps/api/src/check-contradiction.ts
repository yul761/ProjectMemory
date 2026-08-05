import { prisma as defaultPrisma } from "@statecore/db";

export interface ContradictionResult {
  hasContradiction: boolean;
  message: string | null;
}

export async function checkContradiction(
  scopeId: string,
  content: string,
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> },
  db: typeof defaultPrisma = defaultPrisma
): Promise<ContradictionResult> {
  const snapshot = await (db as any).digestStateSnapshot.findFirst({
    where: { scopeId },
    orderBy: { createdAt: "desc" }
  });

  if (!snapshot) return { hasContradiction: false, message: null };

  const state = snapshot.state as any;
  const stableFacts = state?.stableFacts;

  // Write-protected profile facts belong here too. Checking only stableFacts
  // meant the contradiction detector could not see the facts a user is most
  // likely to be contradicted about — the ones taken from their documents —
  // the same blind spot the drift metrics had.
  const protectedProfileFacts: string[] = Array.isArray(state?.factRegistry)
    ? state.factRegistry
        .filter(
          (e: any) =>
            e && e.type === "profile" && !e.supersededBy && !e.retiredAt && typeof e.content === "string"
        )
        .map((e: any) => e.content as string)
    : [];

  const facts = [
    stableFacts?.goal,
    ...(stableFacts?.decisions ?? []),
    ...(stableFacts?.constraints ?? []),
    ...protectedProfileFacts
  ].filter(Boolean).slice(0, 20);

  if (!facts.length) return { hasContradiction: false, message: null };

  try {
    const raw = await llm.chat([
      {
        role: "system",
        content: `You check if a user's request conflicts with their established goals, decisions, and recorded personal facts.
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
