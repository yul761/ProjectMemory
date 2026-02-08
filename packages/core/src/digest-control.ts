import { z } from "zod";
import type { Digest, MemoryEvent, ProjectScope } from "./index";

export type MemoryEventKind = "decision" | "constraint" | "todo" | "note" | "status" | "question" | "noise";

export interface EventFeatures {
  kind: MemoryEventKind;
  importanceScore: number;
  noveltyScore: number;
  docKey?: string;
  references?: string[];
}

export interface DigestState {
  stableFacts: {
    goal?: string;
    constraints?: string[];
    decisions: string[];
  };
  workingNotes: {
    openQuestions?: string[];
    risks?: string[];
    context?: string;
  };
  todos: string[];
}

export interface SelectedEvent {
  event: MemoryEvent;
  features: EventFeatures;
}

export interface SelectionResult {
  selectedEvents: SelectedEvent[];
  documents: MemoryEvent[];
  includeLastDigest: boolean;
  rationale: string[];
}

export interface DeltaCandidate {
  eventId: string;
  reason: string;
  features: EventFeatures;
  event: MemoryEvent;
}

export interface DigestControlConfig {
  eventBudgetTotal: number;
  eventBudgetDocs: number;
  eventBudgetStream: number;
  noveltyThreshold: number;
  maxRetries: number;
  useLlmClassifier: boolean;
  debug: boolean;
}

export interface DigestOutput {
  summary: string;
  changes: string[];
  nextSteps: string[];
}

export const DigestOutputSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  nextSteps: z.array(z.string())
});

const DEFAULT_DIGEST_STATE: DigestState = {
  stableFacts: { decisions: [] },
  workingNotes: {},
  todos: []
};

function deriveStateFromDigest(digest?: Digest | null): DigestState | null {
  if (!digest) return null;
  const decisions = digest.changes
    .split("\\n")
    .map((line) => line.replace(/^-\\s*/, "").trim())
    .filter((line) => /\\b(decide|decision|we will|agreed)\\b/i.test(line));
  const constraints = digest.changes
    .split("\\n")
    .map((line) => line.replace(/^-\\s*/, "").trim())
    .filter((line) => /\\b(constraint|blocked|limitation)\\b/i.test(line));
  return {
    stableFacts: {
      goal: parseGoal(digest.summary),
      constraints,
      decisions
    },
    workingNotes: {},
    todos: digest.nextSteps ?? []
  };
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9\s:]/g, "").trim();
}

function tokenize(value: string) {
  const normalized = normalizeText(value);
  return normalized.split(" ").filter((token) => token.length > 2);
}

function jaccardSimilarity(a: string, b: string) {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

function sameDedupeGroup(a: MemoryEvent, b: MemoryEvent) {
  return a.type === b.type && (a.key ?? "") === (b.key ?? "");
}

function extractKind(content: string): MemoryEventKind {
  const text = content.toLowerCase();
  if (/\b(decide|decision|we will|agreed|approved)\b/.test(text)) return "decision";
  if (/\b(constraint|blocked|limitation|cannot|must not)\b/.test(text)) return "constraint";
  if (/\b(todo|next step|action item|follow up|follow-up)\b/.test(text)) return "todo";
  if (/\b(question|\?)\b/.test(text)) return "question";
  if (/\b(progress|status|done|shipped|completed|finished)\b/.test(text)) return "status";
  if (text.length < 8 || /^(ok|thanks|noted|lol)$/.test(text.trim())) return "noise";
  return "note";
}

function importanceForKind(kind: MemoryEventKind, content: string) {
  const keywordBoost = /\b(decide|decision|constraint|blocked|todo|next)\b/i.test(content) ? 0.15 : 0;
  const base: Record<MemoryEventKind, number> = {
    decision: 0.85,
    constraint: 0.8,
    todo: 0.7,
    status: 0.55,
    question: 0.5,
    note: 0.45,
    noise: 0.05
  };
  return Math.min(1, base[kind] + keywordBoost);
}

function makeFeatures(event: MemoryEvent): EventFeatures {
  const kind = extractKind(event.content);
  return {
    kind,
    importanceScore: importanceForKind(kind, event.content),
    noveltyScore: 0,
    docKey: event.key ?? undefined
  };
}

function dedupeConsecutiveEvents(events: MemoryEvent[], rationale: string[]) {
  const output: MemoryEvent[] = [];
  let prev: MemoryEvent | null = null;
  for (const event of events) {
    if (prev && sameDedupeGroup(prev, event) && jaccardSimilarity(prev.content, event.content) >= 0.92) {
      rationale.push(`dedup:${event.id}`);
      continue;
    }
    output.push(event);
    prev = event;
  }
  return output;
}

function dedupeNearDuplicateEvents(events: MemoryEvent[], rationale: string[]) {
  const kept: MemoryEvent[] = [];
  for (const event of events) {
    const duplicate = kept.find(
      (existing) => sameDedupeGroup(existing, event) && jaccardSimilarity(existing.content, event.content) >= 0.92
    );
    if (duplicate) {
      rationale.push(`dedup_near:${event.id}`);
      continue;
    }
    kept.push(event);
  }
  return kept;
}

function latestDocumentsByKey(events: MemoryEvent[]) {
  const map = new Map<string, MemoryEvent>();
  for (const event of events) {
    if (event.type !== "document" || !event.key) continue;
    if (!map.has(event.key)) {
      map.set(event.key, event);
    }
  }
  return [...map.values()];
}

export function selectEventsForDigest(input: {
  lastDigest?: Digest | null;
  recentEvents: MemoryEvent[];
  eventBudgetTotal: number;
  eventBudgetDocs: number;
  eventBudgetStream: number;
}): SelectionResult {
  const rationale: string[] = [];
  const sorted = [...input.recentEvents].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const dedupedConsecutive = dedupeConsecutiveEvents(sorted, rationale);
  const deduped = dedupeNearDuplicateEvents(dedupedConsecutive, rationale);

  const docs = latestDocumentsByKey(deduped)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, input.eventBudgetDocs);

  const docsById = new Set(docs.map((doc) => doc.id));
  const newestTs = deduped[0]?.createdAt.getTime() ?? Date.now();
  const oldestTs = deduped[deduped.length - 1]?.createdAt.getTime() ?? newestTs;
  const timeRange = Math.max(1, newestTs - oldestTs);
  const streamCandidates = deduped
    .filter((event) => !docsById.has(event.id) && event.type === "stream")
    .map((event) => {
      const features = makeFeatures(event);
      const recency = (event.createdAt.getTime() - oldestTs) / timeRange;
      const keywordBoost = /\b(decide|decision|we will|constraint|blocked|todo|next|risk|goal)\b/i.test(event.content) ? 0.1 : 0;
      const score = features.importanceScore * 0.7 + recency * 0.3 + keywordBoost;
      return { event, features, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.eventBudgetStream);

  const docSelected = docs.map((event) => ({ event, features: makeFeatures(event), score: 1 }));
  const merged = [...docSelected, ...streamCandidates]
    .slice(0, input.eventBudgetTotal)
    .map(({ event, features }) => ({ event, features }));

  rationale.push(`selected_docs:${docSelected.length}`);
  rationale.push(`selected_stream:${Math.max(0, merged.length - docSelected.length)}`);
  if (input.lastDigest) {
    rationale.push("included_last_digest");
  }

  return {
    selectedEvents: merged,
    documents: docs,
    includeLastDigest: Boolean(input.lastDigest),
    rationale
  };
}

function noveltyAgainstDigest(content: string, lastDigestText: string) {
  const overlap = jaccardSimilarity(content, lastDigestText);
  return Math.max(0, 1 - overlap);
}

export function detectDeltas(input: {
  lastDigestText?: string;
  selectedEvents: SelectedEvent[];
  noveltyThreshold: number;
}): DeltaCandidate[] {
  const lastDigestText = input.lastDigestText ?? "";
  const deltas: DeltaCandidate[] = [];
  for (const selected of input.selectedEvents) {
    const novelty = noveltyAgainstDigest(selected.event.content, lastDigestText);
    selected.features.noveltyScore = novelty;
    const keep =
      selected.features.kind === "decision" ||
      selected.features.kind === "constraint" ||
      novelty >= input.noveltyThreshold;
    if (!keep) continue;
    deltas.push({
      eventId: selected.event.id,
      reason: selected.features.kind === "decision" || selected.features.kind === "constraint"
        ? "stable_fact_signal"
        : "novel_event",
      features: selected.features,
      event: selected.event
    });
  }
  return deltas;
}

function parseLinesWithPrefix(text: string, prefix: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

function parseGoal(text: string) {
  const match = text.match(/\bgoal\s*:\s*([^\n.]+)/i);
  return match?.[1]?.trim();
}

export function protectedStateMerge(input: {
  prevState?: DigestState | null;
  deltaCandidates: DeltaCandidate[];
  documents: MemoryEvent[];
}): DigestState {
  const next: DigestState = JSON.parse(JSON.stringify(input.prevState ?? DEFAULT_DIGEST_STATE));
  next.stableFacts.decisions = next.stableFacts.decisions ?? [];
  next.stableFacts.constraints = next.stableFacts.constraints ?? [];
  next.todos = next.todos ?? [];

  const docText = input.documents.map((doc) => doc.content).join("\n");
  const docGoal = parseGoal(docText);
  if (docGoal) {
    next.stableFacts.goal = docGoal;
  }

  const docConstraints = parseLinesWithPrefix(docText, "constraint:");
  for (const constraint of docConstraints) {
    if (!next.stableFacts.constraints.includes(constraint)) {
      next.stableFacts.constraints.push(constraint);
    }
  }

  const docTodos = parseLinesWithPrefix(docText, "todo:");
  for (const todo of docTodos) {
    if (!next.todos.includes(todo)) {
      next.todos.push(todo);
    }
  }

  for (const delta of input.deltaCandidates) {
    const text = delta.event.content.trim();
    const lowered = text.toLowerCase();

    if (delta.features.kind === "decision") {
      if (/\b(revoke|undo|cancel decision)\b/.test(lowered)) {
        const last = next.stableFacts.decisions[next.stableFacts.decisions.length - 1];
        if (last) {
          next.stableFacts.decisions = next.stableFacts.decisions.filter((item) => item !== last);
        }
      } else if (!next.stableFacts.decisions.includes(text)) {
        next.stableFacts.decisions.push(text);
      }

      const decisionGoal = parseGoal(text);
      if (decisionGoal) {
        next.stableFacts.goal = decisionGoal;
      }
    }

    if (delta.features.kind === "constraint" && delta.features.importanceScore >= 0.75) {
      if (!next.stableFacts.constraints.includes(text)) {
        next.stableFacts.constraints.push(text);
      }
    }

    if (delta.features.kind === "todo") {
      if (!next.todos.includes(text)) {
        next.todos.push(text);
      }
    }

    if (delta.features.kind === "question") {
      next.workingNotes.openQuestions = [...(next.workingNotes.openQuestions ?? []), text].slice(-10);
    }

    if (/\b(risk|blocked|blocker)\b/.test(lowered)) {
      next.workingNotes.risks = [...(next.workingNotes.risks ?? []), text].slice(-10);
    }
  }

  next.stableFacts.decisions = [...new Set(next.stableFacts.decisions)];
  next.stableFacts.constraints = [...new Set(next.stableFacts.constraints ?? [])];
  next.todos = [...new Set(next.todos)];

  return next;
}

const classifierSchema = z.array(z.object({
  id: z.string(),
  kind: z.enum(["decision", "constraint", "todo", "note", "status", "question", "noise"]),
  importanceScore: z.number().min(0).max(1)
}));

function renderTemplate(template: string, data: Record<string, string>) {
  let output = template;
  for (const [key, value] of Object.entries(data)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function parseJson<T>(raw: string): T | null {
  const match = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function classifyEventsWithLlm(input: {
  selectedEvents: SelectedEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
}) {
  const eventText = input.selectedEvents
    .map((item) => `${item.event.id}: ${item.event.content}`)
    .join("\n");

  const userPrompt = renderTemplate(input.userPromptTemplate, { events: eventText });
  const raw = await input.llm.chat([
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  const parsed = parseJson<unknown>(raw);
  const validated = classifierSchema.safeParse(parsed);
  if (!validated.success) return;

  const byId = new Map(validated.data.map((item) => [item.id, item]));
  for (const item of input.selectedEvents) {
    const found = byId.get(item.event.id);
    if (!found) continue;
    item.features.kind = found.kind;
    item.features.importanceScore = found.importanceScore;
  }
}

function wordsCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeBullet(text: string) {
  return normalizeText(text.replace(/^-\s*/, ""));
}

export function consistencyCheck(input: {
  output: DigestOutput;
  previousDigest?: Digest | null;
  protectedState: DigestState;
}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = DigestOutputSchema.safeParse(input.output);
  if (!parsed.success) {
    errors.push("invalid_output_schema");
    return { ok: false, errors, warnings };
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
  if (stableGoal && mentionedGoal && normalizeText(stableGoal) !== normalizeText(mentionedGoal)) {
    errors.push("goal_contradiction");
  }

  const summaryLower = input.output.summary.toLowerCase();
  for (const constraint of input.protectedState.stableFacts.constraints ?? []) {
    const keyTokens = tokenize(constraint).slice(0, 3);
    if (!keyTokens.length) continue;
    const mentionsConstraint = keyTokens.every((token) => summaryLower.includes(token));
    if (/\\b(remove|drop|lift|no longer|ignore)\\b/.test(summaryLower) && mentionsConstraint) {
      errors.push("constraint_contradiction");
      break;
    }
  }

  if (input.previousDigest) {
    const prevChanges = new Set(input.previousDigest.changes.split("\n").map(normalizeBullet).filter(Boolean));
    const nextChanges = new Set(input.output.changes.map(normalizeBullet).filter(Boolean));
    const overlap = [...nextChanges].some((change) => prevChanges.has(change));
    if (overlap) {
      errors.push("changes_repeated_from_previous_digest");
    }
  }

  const actionable = /^(add|build|create|define|deliver|document|fix|measure|review|ship|test|update|write|implement|refactor)\b/i;
  const vague = /^(clarify|improve|consider|optimize|iterate)\b/i;
  for (const step of input.output.nextSteps) {
    const normalized = step.trim();
    if (vague.test(normalized) && tokenize(normalized).length < 4) {
      errors.push("vague_next_step");
      continue;
    }
    if (!actionable.test(normalized) && tokenize(normalized).length < 4) {
      warnings.push("weak_next_step");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

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

export async function generateDigestStage2(input: {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  protectedState: DigestState;
  deltaCandidates: DeltaCandidate[];
  documents: MemoryEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
  maxRetries: number;
}): Promise<DigestOutput> {
  const lastDigestText = input.lastDigest
    ? `Summary: ${input.lastDigest.summary}\nChanges: ${input.lastDigest.changes}\nNext steps: ${input.lastDigest.nextSteps.join(", ")}`
    : "(none)";

  let fixInstruction = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    const userPrompt = renderTemplate(input.userPromptTemplate, {
      scopeName: input.scope.name,
      scopeGoal: input.scope.goal ?? "(none)",
      scopeStage: input.scope.stage,
      lastDigest: lastDigestText,
      protectedState: formatProtectedState(input.protectedState),
      deltaCandidates: formatDeltaCandidates(input.deltaCandidates) || "(none)",
      documents: formatDocuments(input.documents) || "(none)"
    });

    const raw = await input.llm.chat([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: `${userPrompt}\n${fixInstruction}` }
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
      nextSteps: validated.data.nextSteps.map((n) => n.trim()).filter(Boolean).slice(0, 3)
    };

    const check = consistencyCheck({
      output: normalized,
      previousDigest: input.lastDigest,
      protectedState: input.protectedState
    });

    if (check.ok) return normalized;

    lastErrors = check.errors;
    fixInstruction = `Fix output. Previous errors: ${check.errors.join(", ")}. Ensure summary<=120 words, changes<=3, nextSteps actionable.`;
  }

  throw new Error(`digest_consistency_failed:${lastErrors.join("|")}`);
}

export async function runDigestControlPipeline(input: {
  scope: ProjectScope;
  lastDigest?: Digest | null;
  recentEvents: MemoryEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  prompts: {
    digestStage2SystemPrompt: string;
    digestStage2UserPrompt: string;
    digestClassifySystemPrompt?: string;
    digestClassifyUserPrompt?: string;
  };
  config: DigestControlConfig;
}): Promise<{ digest: DigestOutput; state: DigestState; selection: SelectionResult; deltas: DeltaCandidate[]; metrics: Record<string, number> }> {
  const metrics: Record<string, number> = {};

  const tSelect = Date.now();
  const selection = selectEventsForDigest({
    lastDigest: input.lastDigest,
    recentEvents: input.recentEvents,
    eventBudgetTotal: input.config.eventBudgetTotal,
    eventBudgetDocs: input.config.eventBudgetDocs,
    eventBudgetStream: input.config.eventBudgetStream
  });
  metrics.selectionMs = Date.now() - tSelect;

  if (input.config.useLlmClassifier && input.prompts.digestClassifySystemPrompt && input.prompts.digestClassifyUserPrompt) {
    const tClassify = Date.now();
    await classifyEventsWithLlm({
      selectedEvents: selection.selectedEvents,
      llm: input.llm,
      systemPrompt: input.prompts.digestClassifySystemPrompt,
      userPromptTemplate: input.prompts.digestClassifyUserPrompt
    });
    metrics.classificationMs = Date.now() - tClassify;
  }

  const tDelta = Date.now();
  const lastDigestText = input.lastDigest
    ? [input.lastDigest.summary, input.lastDigest.changes, input.lastDigest.nextSteps.join(" ")].join("\n")
    : undefined;
  const deltas = detectDeltas({
    lastDigestText,
    selectedEvents: selection.selectedEvents,
    noveltyThreshold: input.config.noveltyThreshold
  });
  metrics.deltaMs = Date.now() - tDelta;

  const tMerge = Date.now();
  const state = protectedStateMerge({
    prevState: deriveStateFromDigest(input.lastDigest),
    deltaCandidates: deltas,
    documents: selection.documents
  });
  metrics.mergeMs = Date.now() - tMerge;

  const tGenerate = Date.now();
  const digest = await generateDigestStage2({
    scope: input.scope,
    lastDigest: input.lastDigest,
    protectedState: state,
    deltaCandidates: deltas,
    documents: selection.documents,
    llm: input.llm,
    systemPrompt: input.prompts.digestStage2SystemPrompt,
    userPromptTemplate: input.prompts.digestStage2UserPrompt,
    maxRetries: input.config.maxRetries
  });
  metrics.generationMs = Date.now() - tGenerate;

  return { digest, state, selection, deltas, metrics };
}
