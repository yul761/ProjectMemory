/**
 * Compose the runtime-turn system prompt: seed persona (voice) first, then the
 * base operational/grounding instructions, which stay last so they remain the
 * authoritative directives. When no persona is configured (e.g. project
 * template), the base prompt is returned unchanged.
 */
export function buildRuntimeSystemPrompt(persona: string | null | undefined, base: string): string {
  const trimmed = persona?.trim();
  if (!trimmed) return base;
  return `${trimmed}\n\n${base}`;
}
