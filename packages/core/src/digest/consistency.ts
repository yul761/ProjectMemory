// Digest/state alignment and the consistency gate.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import type { Digest } from "../index";
import { getDefaultFacetPack, writeProtectedFacets, type FacetPack } from "../facet-registry";
import { isTransientCleanupTodo, normalizeTodoFactText, parseGoal } from "./parse";
import { normalizeText, tokenize } from "./similarity";
import type {
  DeltaCandidate,
  DigestConsistencyResult,
  DigestOutput,
  DigestState,
  DigestStateChange
} from "./types";
import { DigestOutputSchema } from "./types";

function wordsCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeBullet(text: string) {
  return normalizeText(text.replace(/^-\s*/, ""));
}

function mentionsValue(text: string, value: string, tokenCount = 3) {
  return mentionsFact(text, value, tokenCount);
}

function ensureSummaryGoal(summary: string, goal?: string) {
  if (!goal || mentionsValue(summary, goal, 3)) return summary;
  const prefix = `Goal: ${goal}. `;
  const merged = `${prefix}${summary}`.trim();
  if (wordsCount(merged) <= 120) return merged;
  return summary;
}

function appendSummarySentence(parts: string[], sentence: string) {
  if (!sentence.trim()) return;
  const candidate = [...parts, sentence].join(" ").trim();
  if (wordsCount(candidate) <= 120) {
    parts.push(sentence);
  }
}

export function buildProjectedSummary(state: DigestState, narrative: string) {
  const parts: string[] = [];

  if (state.stableFacts.goal) {
    appendSummarySentence(parts, `Goal: ${state.stableFacts.goal}.`);
  }
  const constraints = state.stableFacts.constraints ?? [];
  if (constraints.length) {
    for (let count = constraints.length; count >= 1; count -= 1) {
      const sentence = `Constraints: ${constraints.slice(0, count).join("; ")}.`;
      const before = parts.length;
      appendSummarySentence(parts, sentence);
      if (parts.length > before) break;
    }
  }
  const decisions = state.stableFacts.decisions ?? [];
  if (decisions.length) {
    const recentDecisions = decisions.slice(-8);
    for (let count = recentDecisions.length; count >= 1; count -= 1) {
      const sentence = `Decisions: ${recentDecisions.slice(-count).join("; ")}.`;
      const before = parts.length;
      appendSummarySentence(parts, sentence);
      if (parts.length > before) break;
    }
  }

  const openQuestion = state.workingNotes.openQuestions?.[0];
  if (openQuestion) {
    appendSummarySentence(parts, `Open question: ${openQuestion}.`);
  }
  const risk = state.workingNotes.risks?.[0];
  if (risk) {
    appendSummarySentence(parts, `Active risk: ${risk}.`);
  }

  const statePrefix = parts.join(" ").trim();

  // Append narrative on a separate line so parseGoal does not bleed into it.
  // Honours 120-word cap: only include narrative if combined length fits.
  const trimmedNarrative = narrative.trim();
  if (trimmedNarrative && statePrefix) {
    const combined = `${statePrefix}\n${trimmedNarrative}`;
    if (wordsCount(combined) <= 120) {
      return combined;
    }
    return statePrefix;
  }

  if (statePrefix) return statePrefix;

  // Fallback: state is empty, return narrative alone
  return trimmedNarrative;
}

function projectRecentChange(change: DigestStateChange) {
  switch (change.field) {
    case "decisions":
      if (change.action === "remove") return null;
      return `Decision: ${change.value}`;
    case "constraints":
      if (change.action === "remove") return null;
      return `Constraint: ${change.value}`;
    case "openQuestions":
      return change.action === "remove" ? `Resolved question: ${change.value}` : `Open question: ${change.value}`;
    case "risks":
      return change.action === "remove" ? `Risk cleared: ${change.value}` : `Risk: ${change.value}`;
    case "goal":
      return `Goal: ${change.value}`;
    case "todos":
      if (change.action !== "remove" && isTransientCleanupTodo(change.value)) return null;
      return change.action === "remove" ? `Todo completed: ${change.value}` : `Todo: ${change.value}`;
    default:
      return null;
  }
}

function selectAlignedChanges(output: DigestOutput, state: DigestState) {
  const combined = [output.summary, ...output.changes, ...output.nextSteps].join("\n");
  const recentCandidates = (state.recentChanges ?? [])
    .slice(-6)
    .reverse()
    .map((change) => {
      const value = projectRecentChange(change);
      if (!value) return null;
      const priorityMap: Record<DigestStateChange["field"], number> = {
        goal: 6,
        decisions: 5,
        constraints: 4,
        openQuestions: 4,
        risks: 3,
        todos: 2,
        volatileContext: 1
      };
      return {
        value,
        priority: priorityMap[change.field],
        key: normalizeBullet(value)
      };
    })
    .filter((item): item is { value: string; priority: number; key: string } => Boolean(item))
    .filter((item) => !mentionsValue(combined, item.value.replace(/^[^:]+:\s*/, ""), 3));

  const stateCandidates = [
    ...(state.stableFacts.decisions ?? []).slice(-1).map((value) => ({ value: `Decision: ${value}`, priority: 4 })),
    ...(state.workingNotes.openQuestions ?? []).slice(-1).map((value) => ({ value: `Open question: ${value}`, priority: 3 })),
    ...(state.workingNotes.risks ?? []).slice(-1).map((value) => ({ value: `Risk: ${value}`, priority: 3 })),
    ...(state.stableFacts.constraints ?? []).slice(-1).map((value) => ({ value: `Constraint: ${value}`, priority: 2 }))
  ]
    .map((item) => ({ ...item, key: normalizeBullet(item.value) }))
    .filter((item) => !mentionsValue(combined, item.value.replace(/^[^:]+:\s*/, ""), 3));

  const projected = [...recentCandidates, ...stateCandidates];
  if (projected.length > 0) {
    return [...new Map(projected
      .sort((a, b) => b.priority - a.priority)
      .map((item) => [item.key, item.value])
    ).values()].slice(0, 3);
  }

  return [...new Map(output.changes.map((value) => ({ value, key: normalizeBullet(value) }))
    .map((item) => [item.key, item.value])
  ).values()].slice(0, 3);
}

function canonicalizeNextStep(step: string) {
  const trimmed = step.trim().replace(/\.$/, "");
  const withoutPrefix = trimmed.replace(/^todo\s*:\s*/i, "").trim();
  return withoutPrefix ? withoutPrefix[0].toUpperCase() + withoutPrefix.slice(1) : "";
}

function selectAlignedNextSteps(output: DigestOutput, state: DigestState) {
  const steps: string[] = [];
  for (const todo of state.todos ?? []) {
    const normalized = canonicalizeNextStep(todo);
    if (normalized) steps.push(normalized);
  }
  const activeRisk = state.workingNotes.risks?.[0];
  if (activeRisk) {
    steps.push(`Investigate and resolve ${activeRisk}`);
  }
  const fallback = output.nextSteps.map(canonicalizeNextStep).filter(Boolean);
  const merged = steps.length ? steps : fallback;
  return [...new Map(merged.map((value) => [normalizeText(value), value])).values()].slice(0, 3);
}

export function alignDigestWithState(output: DigestOutput, state: DigestState): DigestOutput {
  return {
    summary: buildProjectedSummary(state, output.summary),
    changes: selectAlignedChanges(output, state),
    nextSteps: selectAlignedNextSteps(output, state),
    profileFacts: output.profileFacts
  };
}

/**
 * The tokens worth matching a fact by.
 *
 * tokenize() puts ASCII tokens ahead of CJK ones, so taking the first N off the
 * raw list handed date and number tokens ("2019-2022") top billing. Those never
 * appear verbatim in a Chinese summary, so `every()` was false and the check
 * silently never fired — for protected facts, which are full of dates. The
 * defence was dead on exactly the facts it existed to protect.
 *
 * Purely numeric tokens are dropped: they are the least discriminating part of a
 * fact ("2019-2022" identifies nothing) and the most likely to be paraphrased
 * away. Everything else is kept, so this only removes false negatives — it does
 * not loosen what counts as a mention.
 */
function factKeyTokens(fact: string, tokenCount: number): string[] {
  const meaningful = tokenize(fact).filter((token) => !/^[\d\-_/.]+$/.test(token));
  return meaningful.slice(0, tokenCount);
}

function mentionsFactWithNegation(text: string, fact: string, negationPattern: RegExp) {
  const normalized = text.toLowerCase();
  const keyTokens = factKeyTokens(fact, 4);
  if (!keyTokens.length) return false;
  const mentionsFact = keyTokens.every((token) => normalized.includes(token));
  return mentionsFact && negationPattern.test(normalized);
}

function mentionsFact(text: string, fact: string, tokenCount = 3) {
  const normalized = text.toLowerCase();
  const keyTokens = factKeyTokens(fact, tokenCount);
  if (!keyTokens.length) return false;
  return keyTokens.every((token) => normalized.includes(token));
}

/**
 * Name the protected fact and quote the line that appears to negate it, so a
 * retry can correct that specific claim instead of regenerating blindly.
 */
function describeConflict(kind: string, fact: string, output: DigestOutput): string {
  const lines = [output.summary, ...output.changes, ...output.nextSteps];
  const keyTokens = tokenize(fact).slice(0, 3);
  const offending = lines.find((line) => {
    const lower = line.toLowerCase();
    return keyTokens.length > 0 && keyTokens.every((token) => lower.includes(token));
  });
  const clip = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);
  return offending
    ? `protected ${kind} "${clip(fact)}" appears negated by: "${clip(offending)}"`
    : `protected ${kind} "${clip(fact)}" appears negated by the new digest`;
}

export function consistencyCheck(input: {
  output: DigestOutput;
  previousDigest?: Digest | null;
  protectedState: DigestState;
  pack?: FacetPack;
}): DigestConsistencyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const note = (code: string, detail: string) => {
    errors.push(code);
    conflicts.push(detail);
  };

  const parsed = DigestOutputSchema.safeParse(input.output);
  if (!parsed.success) {
    errors.push("invalid_output_schema");
    return { ok: false, errors, warnings, conflicts };
  }

  if (wordsCount(input.output.summary) > 120) {
    errors.push("summary_too_long");
  }

  if (input.output.changes.length > 3) {
    errors.push("too_many_changes");
  }

  if (input.output.nextSteps.length < 1 || input.output.nextSteps.length > 3) {
    errors.push("invalid_next_steps_count");
  }

  const stableGoal = input.protectedState.stableFacts.goal;
  const mentionedGoal = parseGoal(input.output.summary);
  // Compare goals by their first sentence only: an LLM summary often appends prose
  // after the goal ("goal: X. Progress is steady."), which must not read as a goal
  // change. parseGoal stays lossless for goal STORAGE; only this contradiction
  // comparison is lenient to trailing sentences.
  // normalizeText removes periods, so split on the RAW string first, then normalize.
  const firstSentence = (s: string) => normalizeText(s.split(/\.\s+/)[0] ?? s);
  if (stableGoal && mentionedGoal && firstSentence(stableGoal) !== firstSentence(mentionedGoal)) {
    errors.push("goal_contradiction");
  }

  const summaryLower = input.output.summary.toLowerCase();
  const combinedText = [
    input.output.summary,
    ...input.output.changes,
    ...input.output.nextSteps
  ].join("\n").toLowerCase();
  if (stableGoal && !mentionedGoal && !mentionsFact(combinedText, stableGoal, 3)) {
    warnings.push("goal_omission");
  }

  const stableConstraints = input.protectedState.stableFacts.constraints ?? [];
  if (
    stableConstraints.length > 0 &&
    stableConstraints.every((constraint) => !mentionsFact(combinedText, constraint, 2))
  ) {
    warnings.push("constraint_omission");
  }
  const stableDecisions = input.protectedState.stableFacts.decisions ?? [];
  if (
    stableDecisions.length > 0 &&
    stableDecisions.every((decision) => !mentionsFact(combinedText, decision, 2))
  ) {
    warnings.push("decision_omission");
  }
  const stableTodos = input.protectedState.todos ?? [];
  if (
    stableTodos.length > 0 &&
    stableTodos.every((todo) => !mentionsFact(combinedText, normalizeTodoFactText(todo), 2))
  ) {
    warnings.push("todo_omission");
  }
  for (const constraint of stableConstraints) {
    const keyTokens = tokenize(constraint).slice(0, 3);
    if (!keyTokens.length) continue;
    const mentionsConstraint = keyTokens.every((token) => summaryLower.includes(token));
    if (/\b(remove|drop|lift|no longer|ignore)\b/.test(summaryLower) && mentionsConstraint) {
      note("constraint_contradiction", describeConflict("constraint", constraint, input.output));
      break;
    }
  }

  const decisionNegation = /\b(revert|reverse|undo|cancel|drop|abandon|deprioritize|no longer|instead)\b/;
  for (const decision of stableDecisions) {
    if (mentionsFactWithNegation(combinedText, decision, decisionNegation)) {
      note("decision_contradiction", describeConflict("decision", decision, input.output));
      break;
    }
  }

  const todoNegation = /\b(remove|delete|drop|cancel|skip|ignore|defer|deprioritize)\b/;
  for (const todo of stableTodos) {
    if (mentionsFactWithNegation(combinedText, normalizeTodoFactText(todo), todoNegation)) {
      note("todo_contradiction", describeConflict("todo", todo, input.output));
      break;
    }
  }

  // Profile write-protected facets: check identity and goals facts in factRegistry.
  // Iterates whatever the tenant's pack marks write-protected, so a new protected
  // facet needs no additional consistency-check wiring.
  // CJK chars have no ASCII word boundaries, so list them without \b anchors.
  const profileNegation = /\b(not|no longer|incorrect|wrong|remove|delete|revoke|cancel|never)\b|放弃|移除|错误|不再/;
  const protectedFacets = writeProtectedFacets(input.pack ?? getDefaultFacetPack());
  const checkedFacets = new Set<string>();
  for (const facetName of protectedFacets) {
    if (checkedFacets.has(facetName)) continue;
    checkedFacets.add(facetName);
    const protectedFacts = (input.protectedState.factRegistry ?? [])
      // A retired fact is no longer believed; failing a digest over a belief the
      // engine has already abandoned would be a false positive.
      .filter((e) => !e.supersededBy && !e.retiredAt && e.facet === facetName)
      .map((e) => e.content);
    for (const fact of protectedFacts) {
      if (mentionsFactWithNegation(combinedText, fact, profileNegation)) {
        errors.push(`profile_${facetName}_contradiction`);
        break;
      }
    }
  }

  if (input.previousDigest) {
    const prevChanges = new Set(input.previousDigest.changes.split("\n").map(normalizeBullet).filter(Boolean));
    const nextChanges = new Set(input.output.changes.map(normalizeBullet).filter(Boolean));
    const allRepeated = nextChanges.size > 0 && [...nextChanges].every((change) => prevChanges.has(change));
    if (allRepeated) {
      errors.push("changes_repeated_from_previous_digest");
    }
  }

  const actionable = /^(add|build|create|define|deliver|document|fix|measure|review|ship|test|update|write|implement|refactor)\b/i;
  const vague = /^(clarify|improve|consider|optimize|iterate)\b/i;
  for (const step of input.output.nextSteps) {
    const normalized = step.trim();
    // English-only heuristics cannot evaluate CJK text — skip both checks for steps
    // containing CJK characters to avoid false positives on legitimate Chinese next-steps.
    const hasCjk = /[一-鿿぀-ヿ가-힯]/.test(normalized);
    if (!hasCjk && vague.test(normalized) && tokenize(normalized).length < 4) {
      errors.push("vague_next_step");
      continue;
    }
    if (!hasCjk && !actionable.test(normalized) && tokenize(normalized).length < 4) {
      warnings.push("weak_next_step");
    }
  }

  return { ok: errors.length === 0, errors, warnings, conflicts };
}
