import type { WorkingMemoryView, StateLayerView } from "./working-memory.compiler";
import {
  formatStateLayerView,
  formatWorkingMemoryView
} from "./working-memory.compiler";

export interface RecentTurnView {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface RetrievalSnippetView {
  id: string;
  content: string;
  createdAt: Date;
}

export interface FastLayerContext {
  systemContext: string;
  workingMemoryBlock: string;
  stableStateBlock: string;
  retrievalBlock: string;
  recentTurnsBlock: string;
  retrievalHints: {
    priorityTerms: string[];
    exclusions: string[];
  };
  summary: string;
}

const MAX_RETRIEVAL_SNIPPETS = 2;
const MAX_RECENT_TURNS = 3;
const MAX_SNIPPET_CHARS = 180;
const MAX_RECENT_TURN_CHARS = 220;

function uniq(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function trimForPrompt(value: string, maxChars: number) {
  const compact = compactWhitespace(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatRecentTurns(turns: RecentTurnView[]) {
  if (!turns.length) return "(none)";
  return turns
    .slice(-MAX_RECENT_TURNS)
    .map((turn) => `- ${turn.role} (${turn.createdAt.toISOString()}): ${turn.content}`)
    .map((line) => trimForPrompt(line, MAX_RECENT_TURN_CHARS))
    .join("\n");
}

function formatRetrievalSnippets(snippets: RetrievalSnippetView[]) {
  if (!snippets.length) return "(none)";
  const filtered = snippets.filter((snippet) => !/^assistant reply:/i.test(snippet.content.trim()));
  const selected = (filtered.length ? filtered : snippets).slice(0, MAX_RETRIEVAL_SNIPPETS);
  return selected
    .map((snippet) => `- ${snippet.createdAt.toISOString()}: ${trimForPrompt(snippet.content, MAX_SNIPPET_CHARS)}`)
    .join("\n");
}

function buildPriorityTerms(message: string, workingMemory?: WorkingMemoryView | null, stateLayer?: StateLayerView | null) {
  const terms = uniq([
    message,
    workingMemory?.goal ?? "",
    ...(workingMemory?.constraints ?? []),
    ...(workingMemory?.decisions ?? []),
    stateLayer?.goal ?? "",
    ...(stateLayer?.constraints ?? []),
    ...(stateLayer?.todos ?? [])
  ]);
  return terms.slice(0, 8);
}

function buildExclusions(workingMemory?: WorkingMemoryView | null, stateLayer?: StateLayerView | null) {
  const exclusions = uniq([
    ...(workingMemory?.openQuestions ?? []).map((item) => `unresolved:${item}`),
    ...(stateLayer?.risks ?? []).map((item) => `risk:${item}`)
  ]);
  return exclusions.slice(0, 6);
}

const CONTEXT_SIZE_WARN_CHARS = 3000;

function detectLayerConflicts(
  workingView?: WorkingMemoryView | null,
  stableView?: StateLayerView | null
): string[] {
  const conflicts: string[] = [];
  const wGoal = workingView?.goal?.trim().toLowerCase();
  const sGoal = stableView?.goal?.trim().toLowerCase();
  if (wGoal && sGoal && wGoal !== sGoal) {
    conflicts.push("goal_mismatch");
  }
  const wDecisions = (workingView?.decisions ?? []).map(d => d.trim().toLowerCase());
  const sDecisions = (stableView?.decisions ?? []).map(d => d.trim().toLowerCase());
  if (wDecisions.length > 0 && sDecisions.length > 0) {
    const hasOverlap = wDecisions.some(wd => sDecisions.some(sd => sd.includes(wd.slice(0, 20)) || wd.includes(sd.slice(0, 20))));
    if (!hasOverlap) conflicts.push("decision_divergence");
  }
  return conflicts;
}

export function compileFastLayerContext(input: {
  message: string;
  workingMemoryView?: WorkingMemoryView | null;
  stateLayerView?: StateLayerView | null;
  retrievalSnippets: RetrievalSnippetView[];
  recentTurns: RecentTurnView[];
}): FastLayerContext {
  const workingMemoryBlock = formatWorkingMemoryView(input.workingMemoryView);
  const stableStateBlock = formatStateLayerView(input.stateLayerView);
  const retrievalBlock = formatRetrievalSnippets(input.retrievalSnippets);
  const recentTurnsBlock = formatRecentTurns(input.recentTurns);
  const retrievalHints = {
    priorityTerms: buildPriorityTerms(input.message, input.workingMemoryView, input.stateLayerView),
    exclusions: buildExclusions(input.workingMemoryView, input.stateLayerView)
  };

  const conflicts = detectLayerConflicts(input.workingMemoryView, input.stateLayerView);
  const conflictNote = conflicts.length > 0
    ? ` Layer conflict detected (${conflicts.join(", ")}): prefer stable state over working memory where they disagree.`
    : "";

  const totalBlockSize = workingMemoryBlock.length + stableStateBlock.length + retrievalBlock.length + recentTurnsBlock.length;
  const sizeWarning = totalBlockSize > CONTEXT_SIZE_WARN_CHARS ? "context_large" : null;

  const summaryParts = [
    input.workingMemoryView?.goal ? `working_goal:${input.workingMemoryView.goal}` : null,
    input.stateLayerView?.goal ? `stable_goal:${input.stateLayerView.goal}` : null,
    input.retrievalSnippets.length ? `retrieval:${input.retrievalSnippets.length}` : null,
    input.recentTurns.length ? `recent_turns:${input.recentTurns.length}` : null,
    sizeWarning
  ].filter((item): item is string => Boolean(item));

  return {
    systemContext: `Fast Layer: respond quickly using recent turns, retrieval snippets, working memory, and stable state. Stable state remains authoritative.${conflictNote}`,
    workingMemoryBlock,
    stableStateBlock,
    retrievalBlock,
    recentTurnsBlock,
    retrievalHints,
    summary: summaryParts.join("; ") || "message_only"
  };
}
