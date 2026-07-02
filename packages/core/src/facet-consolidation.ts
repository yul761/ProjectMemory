/**
 * Removes internal bookkeeping that the digest LLM sometimes leaks into a
 * user-facing profile fact: parentheticals like "（提醒 ID：<uuid>）" /
 * "(reminder id: <uuid>)" and any bare UUID, then tidies leftover whitespace
 * and dangling separators. Clean text is returned unchanged.
 */
export function stripInternalIds(value: string): string {
  return value
    // full/half-width parenthetical containing an ID label + payload
    .replace(/[（(]\s*[^（()）]*?(?:提醒\s*ID|reminder\s*id|\bID)\s*[:：][^（()）]*[)）]/gi, "")
    // any bare UUID left behind
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s·:：,\-]+$/g, "")
    .trim();
}
