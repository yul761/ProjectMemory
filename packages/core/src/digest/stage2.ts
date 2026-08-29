// Stage 2: prompt assembly, chunking, budgets, and the digest generation call.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import type { Digest, MemoryEvent, ProjectScope } from "../index";
import { alignDigestWithState, buildProjectedSummary, consistencyCheck } from "./consistency";
import { normalizeText } from "./similarity";
import { parseJson, renderTemplate } from "./llm";
import type { DeltaCandidate, DigestControlConfig, DigestOutput, DigestState, FactRegistryEntry } from "./types";
import { DigestOutputSchema } from "./types";

function formatProtectedState(state: DigestState) {
  return JSON.stringify(state, null, 2);
}

function formatDeltaCandidates(candidates: DeltaCandidate[]) {
  return candidates
    .map((candidate) => `- [${candidate.features.kind}] ${candidate.event.content}`)
    .join("\n");
}

function formatDocuments(docs: MemoryEvent[]) {
  return docs.map((doc) => `- ${doc.key ?? doc.id}: ${doc.content}`).join("\n");
}

/**
 * Per-section ceiling for the stage-2 prompt.
 *
 * Sized against the SMALLEST context we expect to run on (gpt-4o-mini, 128k
 * tokens) rather than the largest: a budget tuned to a 272k-token model silently
 * becomes an overflow the moment someone points StateCore at a smaller one, and
 * the failure mode is a dead digest rather than a degraded one.
 */
export const STAGE2_SECTION_CHAR_BUDGET = 60_000;

/**
 * How many stage-2 passes one digest run will make.
 *
 * Chunking removes the silent truncation, but it must not turn a bulk import
 * into an unbounded number of LLM calls. Events beyond the ceiling are not lost:
 * they stay in the store and the next digest run picks them up. 12 passes is
 * ~720k characters of corpus per run.
 */
export const STAGE2_MAX_CHUNKS = 12;

/**
 * Split the delta candidates into prompt-sized groups.
 *
 * `clipSection` used to cut this section at the budget and drop the remainder on
 * the floor, so on any corpus larger than one prompt the extractor only ever saw
 * the beginning of it. Measured on LongMemEval: ~490k characters of sessions
 * against a 60k window, about 12% reaching extraction. Bulk import
 * (`ingest:docs`) hits the same wall.
 *
 * When the corpus overflows the pass ceiling the tail is kept: events arrive
 * oldest-first, and the recent end is both what a reader is most likely to ask
 * about and the part that has not yet had a chance to be digested.
 */
export function chunkDeltaCandidates(
  candidates: DeltaCandidate[],
  budget = STAGE2_SECTION_CHAR_BUDGET,
  maxChunks = STAGE2_MAX_CHUNKS
): DeltaCandidate[][] {
  if (candidates.length === 0) return [];

  const chunks: DeltaCandidate[][] = [];
  let current: DeltaCandidate[] = [];
  let size = 0;

  for (const candidate of candidates) {
    const cost = candidate.event.content.length;
    // A single event over budget cannot be made to fit; it goes alone and the
    // per-section clip still bounds what the model sees.
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(candidate);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);

  return chunks.length <= maxChunks ? chunks : chunks.slice(chunks.length - maxChunks);
}

/**
 * Backstop on the fully assembled prompt. Per-section limits cannot bound the
 * total on their own -- the sections are capped independently, and any part not
 * routed through one of them (last digest, forgotten facts, fix instructions)
 * is unbounded. This is the last point before the model sees the text.
 * ~4 chars/token, so 320k chars is roughly 80k tokens: comfortable inside 128k.
 */
const STAGE2_TOTAL_CHAR_BUDGET = 320_000;

/**
 * Bounding `selectEventsForDigest` is not enough: the protected state is a full
 * JSON dump that re-expands event content across facets, and the delta list
 * carries raw content too, so either can outgrow the events they came from.
 * This is the single point where the prompt is actually handed to the model, so
 * it is the only place a size guard cannot be bypassed by an upstream path.
 *
 * A digest built from a clipped section is still a digest; blowing the context
 * limit fails the whole job and leaves the scope with no state at all.
 *
 * Line-oriented sections are safe to cut at a character offset. The protected
 * state is NOT — it is serialized JSON, and slicing it mid-structure hands the
 * model malformed input, which in practice produces output that then trips the
 * consistency gate. State is bounded structurally instead, before serializing.
 */
function clipSection(text: string, label: string, budget = STAGE2_SECTION_CHAR_BUDGET) {
  if (text.length <= budget) return text;
  // The marker stays in the prompt itself rather than going to a log: importing
  // the logger here would make digest-control depend on ./index at runtime, and
  // that import is deliberately type-only to avoid a cycle.
  const cut = text.lastIndexOf("\n", budget);
  return text.slice(0, cut > budget / 2 ? cut : budget)
    + `\n…[${label} clipped: ${text.length} chars exceeded ${budget}]`;
}

/** Trim a string array until its combined length fits, keeping entries intact. */
function boundStrings(values: string[] | undefined, budget: number): string[] | undefined {
  if (!values?.length) return values;
  const kept: string[] = [];
  let used = 0;
  for (const value of values) {
    if (used + value.length > budget) break;
    kept.push(value);
    used += value.length;
  }
  // Never return an empty list where there was content: one entry beats none.
  if (!kept.length) kept.push(values[0].slice(0, Math.max(1, budget)));
  return kept;
}

/**
 * Bound the protected state by dropping whole entries, so what reaches the model
 * is always valid JSON. Provenance/confidence/evidence are derived bookkeeping
 * and are dropped first — the facts themselves are what the digest reasons over.
 */
export function boundProtectedState(state: DigestState, budget = STAGE2_SECTION_CHAR_BUDGET): DigestState {
  if (JSON.stringify(state).length <= budget) return state;

  const share = Math.floor(budget / 4);
  const bounded: DigestState = {
    ...state,
    stableFacts: {
      goal: state.stableFacts.goal,
      constraints: boundStrings(state.stableFacts.constraints, share),
      decisions: boundStrings(state.stableFacts.decisions, share) ?? []
    },
    workingNotes: {
      ...state.workingNotes,
      openQuestions: boundStrings(state.workingNotes.openQuestions, share),
      risks: boundStrings(state.workingNotes.risks, share)
    },
    todos: boundStrings(state.todos, share) ?? [],
    volatileContext: boundStrings(state.volatileContext, share)
  };
  delete bounded.provenance;
  delete bounded.confidence;
  delete bounded.evidenceRefs;
  if (bounded.factRegistry) {
    const registry: FactRegistryEntry[] = [];
    let used = 0;
    for (const entry of bounded.factRegistry) {
      const size = JSON.stringify(entry).length;
      if (used + size > share) break;
      registry.push(entry);
      used += size;
    }
    bounded.factRegistry = registry;
  }
  return bounded;
}

/**
 * Negative instruction fed to the digest LLM: the user has explicitly forgotten these facts,
 * so the model must not re-extract them even if the source events reword or re-bucket them.
 *
 * This is the SEMANTIC guard for forget. The deterministic hash-based pruneForgottenFacts is a
 * verbatim (group|text) match, so any re-extraction with slightly different wording — or the same
 * text under a different display group — dodges it and the fact resurfaces. The LLM can recognise
 * "means the same thing" where the hash cannot, so we ask it to omit forgotten content at the
 * source; the hash prune remains the backstop for exact carry-forwards.
 */
function formatForgottenFacts(contents?: readonly string[]): string {
  const cleaned = [...new Set((contents ?? []).map((c) => c.trim()).filter(Boolean))];
  if (cleaned.length === 0) return "";
  const lines = cleaned.map((c) => `- ${c}`).join("\n");
  return (
    `\n\nFORGOTTEN BY THE USER — the user has explicitly deleted the following facts. Do NOT record, ` +
    `restate, or re-derive any of them, and reject anything that means the same thing even if the ` +
    `wording differs or it falls under a different category. Omit them entirely from the summary, ` +
    `changes, and profileFacts:\n${lines}\n`
  );
}

interface Stage2Input {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  protectedState: DigestState;
  deltaCandidates: DeltaCandidate[];
  documents: MemoryEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
  maxRetries: number;
  forgottenFacts?: readonly string[];
}

/**
 * Run stage 2 over the whole corpus, one prompt-sized pass at a time.
 *
 * Each pass carries the previous pass's output forward as its `lastDigest`,
 * which is the same shape as consecutive incremental digest runs — the summary
 * accumulates rather than being overwritten by the final chunk. Facts are the
 * union across passes, deduplicated, since a durable fact restated in two
 * chunks is one fact.
 */
export async function generateDigestStage2(input: Stage2Input): Promise<DigestOutput> {
  const chunks = chunkDeltaCandidates(input.deltaCandidates);
  if (chunks.length <= 1) return runStage2Pass(input);

  const facts: { facet: string; value: string }[] = [];
  const seen = new Set<string>();
  let carried: Digest | null | undefined = input.lastDigest;
  let last: DigestOutput | null = null;

  for (const chunk of chunks) {
    // One chunk that cannot satisfy the consistency gate must not discard the
    // other eight. Before chunking a throw here cost one digest; now it would
    // cost the whole corpus, so a failed pass is skipped rather than fatal.
    let out: DigestOutput;
    try {
      out = await runStage2Pass({ ...input, deltaCandidates: chunk, lastDigest: carried });
    } catch {
      continue;
    }
    for (const fact of out.profileFacts ?? []) {
      const key = `${fact.facet}|${normalizeText(fact.value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
    last = out;
    carried = {
      ...(carried ?? {}),
      summary: out.summary,
      changes: out.changes.join("; "),
      nextSteps: out.nextSteps
    } as Digest;
  }

  // Every pass failed. Nothing to degrade to, so fail the way a single pass does.
  if (!last) return runStage2Pass({ ...input, deltaCandidates: chunks[chunks.length - 1] });

  return { ...last, profileFacts: facts };
}

async function runStage2Pass(input: Stage2Input): Promise<DigestOutput> {
  const lastDigestText = input.lastDigest
    ? `Summary: ${input.lastDigest.summary}\nChanges: ${input.lastDigest.changes}\nNext steps: ${input.lastDigest.nextSteps.join(", ")}`
    : "(none)";
  const forgottenBlock = formatForgottenFacts(input.forgottenFacts);

  let fixInstruction = "";
  let lastErrors: string[] = [];
  // The consistency gate judges the summary, changes, and next steps. The facts
  // extracted on the way are a separate output and did not fail anything, so
  // every degraded return below carries them out rather than discarding a pass's
  // worth of extraction along with its prose.
  let extracted: { facet: string; value: string }[] = [];

  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    const userPrompt = renderTemplate(input.userPromptTemplate, {
      scopeName: input.scope.name,
      scopeGoal: input.scope.goal ?? "(none)",
      scopeStage: input.scope.stage,
      lastDigest: lastDigestText,
      protectedState: formatProtectedState(boundProtectedState(input.protectedState)),
      deltaCandidates: clipSection(formatDeltaCandidates(input.deltaCandidates), "deltaCandidates") || "(none)",
      documents: clipSection(formatDocuments(input.documents), "documents") || "(none)"
    });

    const assembled = clipSection(
      `${userPrompt}${forgottenBlock}\n${fixInstruction}`,
      "stage2 prompt",
      STAGE2_TOTAL_CHAR_BUDGET
    );

    const raw = await input.llm.chat([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: assembled }
    ]);

    const parsed = parseJson<DigestOutput>(raw);
    const validated = DigestOutputSchema.safeParse(parsed);
    if (!validated.success) {
      lastErrors = ["invalid_json_output"];
      fixInstruction = `Fix output. Previous errors: ${lastErrors.join(", ")}. Return strict JSON only.`;
      continue;
    }

    const normalized: DigestOutput = {
      summary: validated.data.summary.trim(),
      changes: validated.data.changes.map((c) => c.trim()).filter(Boolean).slice(0, 3),
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean).slice(0, 3),
      profileFacts: (validated.data.profileFacts ?? [])
        .map((pf) => ({
          facet: pf.facet.trim(),
          value: pf.value.trim(),
          ...(pf.entities?.length
            ? { entities: pf.entities.map((e) => e.trim().toLowerCase()).filter(Boolean).slice(0, 10) }
            : {})
        }))
        .filter((pf) => Boolean(pf.facet) && Boolean(pf.value))
    };

    const aligned = alignDigestWithState(normalized, input.protectedState);
    if (aligned.profileFacts?.length) extracted = aligned.profileFacts;

    const check = consistencyCheck({
      output: aligned,
      previousDigest: input.lastDigest,
      protectedState: input.protectedState
    });

    if (check.ok) return aligned;

    if (
      input.lastDigest &&
      check.errors.length === 1 &&
      check.errors[0] === "changes_repeated_from_previous_digest"
    ) {
      return {
        summary: input.lastDigest.summary,
        changes: [],
        nextSteps: input.lastDigest.nextSteps?.length
          ? input.lastDigest.nextSteps.slice(0, 3)
          : ["Review recent events for changes."],
        profileFacts: extracted
      };
    }

    lastErrors = check.errors;
    // Name what conflicted. "Previous errors: todo_contradiction" tells the model
    // nothing it can act on, so the retry just re-rolls; quoting the protected
    // fact and the offending line makes it a targeted correction.
    const detail = (check.conflicts ?? []).filter(Boolean);
    fixInstruction = detail.length
      ? `Fix output. The new digest conflicts with state the user has already established:\n`
        + detail.map((d) => `- ${d}`).join("\n")
        + `\nKeep those facts intact unless the source events explicitly revoke them. `
        + `Ensure summary<=120 words, changes<=3, nextSteps actionable.`
      : `Fix output. Previous errors: ${check.errors.join(", ")}. Ensure summary<=120 words, changes<=3, nextSteps actionable.`;
  }

  // Retries exhausted. Throwing here loses the whole digest — including every
  // fact that did NOT conflict — and leaves the scope with no state at all, which
  // is the opposite of the continuity the consistency gate exists to protect.
  // Carry the previous digest forward instead, flagged so the degradation is
  // visible rather than silent. Only a scope with no prior digest has nothing to
  // fall back to, and that case still fails loudly.
  if (input.lastDigest) {
    return {
      summary: input.lastDigest.summary,
      changes: [],
      nextSteps: input.lastDigest.nextSteps?.length
        ? input.lastDigest.nextSteps.slice(0, 3)
        : ["Review recent events for changes."],
      profileFacts: extracted,
      degraded: { reason: "consistency_failed", errors: lastErrors }
    };
  }

  // First digest for the scope: fall back to the protected state that the merge
  // already produced, so ingestion still yields usable memory instead of nothing.
  const projected = buildProjectedSummary(input.protectedState, "");
  if (projected) {
    return {
      summary: projected,
      changes: [],
      nextSteps: ["Review recent events for changes."],
      profileFacts: extracted,
      degraded: { reason: "consistency_failed_no_prior_digest", errors: lastErrors }
    };
  }

  throw new Error(`digest_consistency_failed:${lastErrors.join("|")}`);
}
