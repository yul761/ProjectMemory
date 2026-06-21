/**
 * Compose the runtime-turn system prompt (P2a + P2b-v1).
 *
 * Segment order — empty segments are omitted:
 *   1. Seed persona — voice/character (P2a)
 *   2. 交流风格（用户要求）— explicit style preferences (P2b-v1, only when styleLines non-empty)
 *   3. Base operational/grounding instructions — ALWAYS last, always authoritative
 *
 * When persona is absent and styleLines is empty/null, base is returned unchanged
 * (project template P2a fallback — zero behavioural diff for non-personal scopes).
 */
export function buildRuntimeSystemPrompt(
  persona: string | null | undefined,
  styleLines: string[] | null | undefined,
  base: string
): string {
  const parts: string[] = [];

  const trimmedPersona = persona?.trim();
  if (trimmedPersona) parts.push(trimmedPersona);

  const activeStyles = (styleLines ?? []).map((s) => s.trim()).filter(Boolean);
  if (activeStyles.length > 0) {
    parts.push(`交流风格（用户要求）:\n${activeStyles.map((s) => `- ${s}`).join("\n")}`);
  }

  parts.push(base);
  return parts.join("\n\n");
}
