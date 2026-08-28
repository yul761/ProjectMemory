// Text-similarity primitives: tokenization, Jaccard, CJK-aware fact matching,
// and the note-revision matcher. Split out of digest-control.ts (2026-08-28) —
// bodies moved verbatim.

export function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s:]/g, " ").replace(/\s+/g, " ").trim();
}

export function tokenize(value: string) {
  // CJK path: extract bigrams/unigrams from lowercased text BEFORE normalizeText strips CJK chars.
  // Mirrors RetrieveService.tokenize in packages/core/src/index.ts.
  const lower = value.toLowerCase();
  const cjkTokens: string[] = [];
  const runs = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      cjkTokens.push(run); // single-char run: keep as unigram
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      cjkTokens.push(run.slice(i, i + 2)); // overlapping step-1 bigram
    }
  }
  // ASCII path: normalizeText strips CJK to spaces, then we tokenize as before.
  const normalized = normalizeText(value);
  const asciiTokens = normalized
    .split(" ")
    .map((token) => token.replace(/:+$/g, ""))
    .filter((token) => token.length > 2)
    .map((token) => {
      if (token === "docs" || token === "doc") return "documentation";
      if (token === "blocker") return "blocked";
      return token;
    });
  // CJK tokens are appended after ASCII tokens and bypass the length > 2 filter
  // (2-char bigrams would otherwise be dropped).
  return [...asciiTokens, ...cjkTokens];
}

export function jaccardSimilarity(a: string, b: string) {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * ASCII-only content tokens derived using the SAME path as tokenize()'s ASCII branch:
 * normalizeText → split → strip trailing colons → filter length > 2 → apply synonyms.
 * This guarantees the ascii-content set is a strict subset of jaccardSimilarity's token set,
 * so if jaccard(a, b) >= threshold for English, the shared tokens are also in both ascii sets
 * → sets intersect → asciiContentDiverges returns false → guard is a true no-op for English.
 * CJK chars are stripped to spaces by normalizeText and never enter the ascii set — the
 * PostgreSQL-vs-MySQL divergence guard for CJK is fully preserved.
 */
function asciiContentTokens(s: string): Set<string> {
  const normalized = normalizeText(s);
  return new Set(
    normalized
      .split(/\s+/)
      .map((token) => token.replace(/:+$/g, ""))
      .filter((token) => token.length > 2)
      .map((token) => {
        if (token === "docs" || token === "doc") return "documentation";
        if (token === "blocker") return "blocked";
        return token;
      })
  );
}

/**
 * Returns true iff BOTH strings have ≥ 1 ASCII content token AND their ASCII token sets
 * are completely disjoint. Pure-CJK facts (no ASCII tokens in either string) return false
 * so the guard is a no-op for fully Chinese content — bigrams remain the only signal.
 * Errs toward "distinct": a definite ASCII difference overrides bigram similarity.
 */
function asciiContentDiverges(a: string, b: string): boolean {
  const tokA = asciiContentTokens(a);
  const tokB = asciiContentTokens(b);
  if (tokA.size === 0 || tokB.size === 0) return false;
  return [...tokA].every((t) => !tokB.has(t));
}

/**
 * CJK-aware "same fact" predicate used at precision-critical sites (factRegistry, identity
 * protection). Passes RAW strings to jaccardSimilarity so CJK bigrams are used, then guards
 * against the over-merge case where shared bigrams mask divergent ASCII content
 * (e.g. 我决定用PostgreSQL vs 我决定用MySQL → bigram Jaccard ≈ 0.6 but ASCII sets disjoint).
 * For English-only facts this is a no-op: tokenize() normalises ASCII internally, and
 * asciiContentDiverges returns false when both sets share at least one token.
 */
export function sameFactCjkAware(a: string, b: string, threshold: number): boolean {
  return jaccardSimilarity(a, b) >= threshold && !asciiContentDiverges(a, b);
}

/**
 * Note-revision matcher: like tokenize(), but KEEPS short ASCII tokens.
 * tokenize()'s `length > 2` filter strips version/index tokens ("v1", "90",
 * "0"), which is exactly the information that distinguishes a revision
 * ("API v1 key…" → "API v2 key…", most tokens shared) from a genuinely
 * distinct short note ("note-0" vs "note-1", almost nothing shared). Dedup
 * must never fuzzy-match notes (data loss); supersession may, because the
 * matched note survives on the chain.
 */
function tokenizeKeepingShortTokens(value: string) {
  const lower = value.toLowerCase();
  const cjkTokens: string[] = [];
  const runs = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      cjkTokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      cjkTokens.push(run.slice(i, i + 2));
    }
  }
  const asciiTokens = normalizeText(value)
    .split(" ")
    .map((token) => token.replace(/:+$/g, ""))
    .filter((token) => token.length > 0);
  return [...asciiTokens, ...cjkTokens];
}

const NOTE_REVISION_THRESHOLD = 0.7;

/**
 * True iff `candidate` reads as a revision of `existing`: the shared portion
 * dominates (short-token-preserving Jaccard ≥ 0.7) and the ASCII payloads do
 * not diverge outright (PostgreSQL vs MySQL behind shared CJK context is a
 * different fact, not a revision).
 */
export function isNoteRevision(existing: string, candidate: string): boolean {
  const tokensA = new Set(tokenizeKeepingShortTokens(existing));
  const tokensB = new Set(tokenizeKeepingShortTokens(candidate));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 && intersection / union >= NOTE_REVISION_THRESHOLD && !asciiContentDiverges(existing, candidate);
}

export function extractNumberTokens(value: string) {
  return normalizeText(value).match(/\b\d+\b/g) ?? [];
}

export function decisionValuesAreComparable(existing: string, candidate: string) {
  const existingNumbers = extractNumberTokens(existing);
  const candidateNumbers = extractNumberTokens(candidate);
  if (existingNumbers.length || candidateNumbers.length) {
    return existingNumbers.join(",") === candidateNumbers.join(",");
  }
  return true;
}
