/**
 * The one tokenizer behind both sides of the lexical index.
 *
 * The candidate pool used to be "the newest 200 events": anything older was
 * unreachable however relevant, because the only DB query retrieval made was
 * ORDER BY createdAt. The fix is an inverted token index — but only if the
 * write path and the query path agree on what a token is. FTS engines were
 * rejected for exactly that reason: Postgres tsvector and SQLite FTS5 each
 * tokenize differently (and neither segments CJK), which would make indexed
 * recall diverge from the in-process scorer that ranks the candidates. This
 * function is shared by ingestion, retrieval, and the relevance scorer, so
 * a term matches in the index iff it matches in the score.
 *
 * ASCII: lowercased words longer than 2 chars. CJK: adjacent bigrams over
 * ideograph/kana/hangul runs (a lone char stays a unigram), the standard
 * segmentation-free approach. Deduplicated, insertion-ordered, capped.
 */

/** Upper bound on tokens indexed per event, so one huge document cannot bloat the table. */
export const MAX_TOKENS_PER_EVENT = 512;

export function tokenizeText(text: string): string[] {
  const lower = text.toLowerCase();
  const asciiTokens = lower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
  const cjkTokens: string[] = [];
  // Contiguous runs of CJK ideographs / Japanese kana / Korean syllables.
  const runs = lower.match(/[一-鿿぀-ヿ가-힯]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      cjkTokens.push(run); // single-char run: keep as unigram
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      cjkTokens.push(run.slice(i, i + 2)); // adjacent bigram
    }
  }
  return [...asciiTokens, ...cjkTokens];
}

export function tokenizeForIndex(text: string, cap = MAX_TOKENS_PER_EVENT): string[] {
  return [...new Set(tokenizeText(text))].slice(0, cap);
}
