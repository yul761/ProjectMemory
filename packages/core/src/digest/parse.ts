// Parsers for digest text: prefixed lines and goal extraction.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.

export function parseLinesWithPrefix(text: string, prefix: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

export function parseGoal(text: string) {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^goal\s*:/i.test(entry));
  if (!line) return undefined;
  const raw = line.replace(/^goal\s*:/i, "").trim();
  const sectionBoundary = raw.match(/^(.*?)(?:\.\s+(?:constraints?|decisions?|todos?|next steps?|(?:active\s+)?risks?|(?:open\s+)?questions?|changes?|status)\b.*)?$/i);
  return sectionBoundary?.[1]?.trim().replace(/\.$/, "") || undefined;
}

function cleanNaturalGoalPhrase(value: string) {
  return value
    .replace(/\b(?:without|while|but)\b.+$/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
}

export function extractNaturalGoal(text: string) {
  const lines = text
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(
      /(?:^|[,:]\s*|\b)(?:i am|i'm)\s+trying\s+to\s+([^,.;?!]+)/i
    ) || line.match(
      /(?:^|[,:]\s*|\b)(?:i want to|i'd like to|i would like to|i need to|my goal is to|i'm looking to|i am looking to)\s+([^,.;?!]+)/i
    );

    if (match?.[1]) {
      return cleanNaturalGoalPhrase(match[1]);
    }
  }

  return undefined;
}

export function stripStructuredLabel(text: string, labels: string[]) {
  if (!labels.length) return text.trim();
  const pattern = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return text.replace(new RegExp(`^\\s*(?:${pattern})\\s*:\\s*`, "i"), "").trim();
}

export function normalizeConstraintFactText(text: string) {
  return stripStructuredLabel(text, ["constraint"]).trim();
}

export function normalizeTodoFactText(text: string) {
  return text.replace(/^\s*todo\s*:\s*/i, "").trim();
}

export function isTransientCleanupTodo(text: string) {
  const normalized = normalizeTodoFactText(text).toLowerCase();
  return /\b(tmp|temporary|cleanup|clean old|sort .*logs?|rename .*screenshot|duplicate .*screenshot|duplicate .*notebook)\b/.test(normalized);
}
