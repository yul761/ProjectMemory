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

/**
 * Dropped from the index (and, via the shared tokenizer, from index queries) —
 * not from the relevance scorer, which stays ratio-based and unchanged. Two
 * reasons: a match-count ranking lets "the and for was" outvote "deployment
 * rollback", and counting is an aggregation over the token's whole row set, so
 * the commonest words are also the most expensive ones to ask about.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "was", "are", "this", "that", "with", "from", "have",
  "has", "had", "not", "but", "you", "your", "all", "can", "will", "its",
  "our", "out", "they", "them", "then", "than", "there", "their",
  "what", "when", "where", "which", "who", "how", "why", "been", "being",
  "into", "over", "under", "only", "also", "some", "such", "very", "just",
  "more", "most", "other", "about", "after", "before", "because", "would",
  "could", "should", "does", "did", "done", "were", "while", "each", "both",
  "any", "may", "might", "must", "between", "during", "without", "within"
]);

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
  const deduped = [...new Set(tokenizeText(text))].filter((token) => !STOPWORDS.has(token));
  if (deduped.length <= cap) return deduped;
  // Over the cap, interleave ASCII words and CJK bigrams instead of slicing in
  // insertion order — tokenizeText emits all ASCII first, so a plain slice on
  // a long bilingual text would silently drop every CJK token.
  const isCjk = (t: string) => /[一-鿿぀-ヿ가-힯]/.test(t);
  const ascii = deduped.filter((t) => !isCjk(t));
  const cjk = deduped.filter(isCjk);
  const out: string[] = [];
  for (let i = 0; out.length < cap; i += 1) {
    const a = ascii[i];
    const c = cjk[i];
    if (a === undefined && c === undefined) break;
    if (a !== undefined) out.push(a);
    if (c !== undefined && out.length < cap) out.push(c);
  }
  return out;
}
