export interface WorkingMemoryState {
  currentGoal?: string;
  activeConstraints: string[];
  recentDecisions: string[];
  progressSummary?: string;
  openQuestions: string[];
  taskFrame?: string;
  sourceEventIds: string[];
}

export interface WorkingMemoryEventLike {
  id: string;
  type: "stream" | "document";
  key?: string | null;
  content: string;
  createdAt: Date;
  role?: "user" | "assistant" | "system";
}

export interface WorkingMemoryExtractorOptions {
  maxItemsPerField?: number;
}

export interface PartialWorkingMemoryState {
  currentGoal?: string;
  activeConstraints?: string[];
  recentDecisions?: string[];
  progressSummary?: string;
  openQuestions?: string[];
  taskFrame?: string;
  sourceEventIds?: string[];
}

function uniq(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalizeContent(content: string) {
  if (content.includes("\n")) {
    return content.replace(/\r\n/g, "\n");
  }
  if (content.includes("\\n")) {
    return content.replace(/\\n/g, "\n");
  }
  return content;
}

function splitContentLines(content: string) {
  return normalizeContent(content)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeLineValue(line: string, prefix: RegExp) {
  return line.replace(prefix, "").trim();
}

function cleanNaturalPhrase(value: string) {
  return value
    .replace(/^(that is|that's|something that is|something|anything that is|anything)\s+/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
}

function cleanGoalPhrase(value: string) {
  return cleanNaturalPhrase(value)
    .replace(/\b(?:without|while|but)\b.+$/i, "")
    .trim();
}

function splitNaturalClauses(line: string) {
  return line
    .split(/\s*,\s*|\s*;\s*|\.\s+/)
    .map((part) => part.trim().replace(/[.]+$/g, "").replace(/^(?:and|but)\s+/i, ""))
    .filter(Boolean);
}

function extractGoalFromContent(content: string) {
  const lines = splitContentLines(content);
  for (const line of lines) {
    if (/^goal\s*:/i.test(line)) {
      return normalizeLineValue(line, /^goal\s*:/i);
    }
    const naturalGoalMatch = line.match(
      /(?:^|[,:]\s*|\b)(?:i am|i'm)\s+trying\s+to\s+([^,.;?!]+)/i
    ) || line.match(
      /(?:^|[,:]\s*|\b)(?:i want to|i'd like to|i would like to|i need to|my goal is to|i'm looking to|i am looking to)\s+([^,.;?!]+)/i
    );
    if (naturalGoalMatch?.[1]) {
      return cleanGoalPhrase(naturalGoalMatch[1]);
    }
    const questionGoalMatch = line.match(
      /(?:^|[,:]\s*|\b)(?:how can i|what(?:'s| is) the best way to|can you help me(?:\s+to)?)\s+([^?]+)/i
    );
    if (questionGoalMatch?.[1]) {
      return cleanGoalPhrase(questionGoalMatch[1]);
    }
  }
  return null;
}

function extractConstraintsFromContent(content: string) {
  const lines = splitContentLines(content);
  const constraints = [];
  for (const line of lines) {
    if (/^constraint\s*:/i.test(line)) {
      constraints.push(normalizeLineValue(line, /^constraint\s*:/i));
      continue;
    }
    if (/^constraint reminder\s*:/i.test(line)) {
      constraints.push(normalizeLineValue(line, /^constraint reminder\s*:/i));
      continue;
    }
    const preferMatch = line.match(/(?:^|[,:]\s*|\b)(?:i prefer|i'd prefer|prefer)\s+([^.;?!]+)/i);
    if (preferMatch?.[1]) {
      constraints.push(cleanNaturalPhrase(preferMatch[1]));
      continue;
    }
    const needMatch = line.match(
      /(?:^|[,:]\s*|\b)(?:i need|i'm looking for|i am looking for)\s+(?:something\s+)?([^.;?!]+)/i
    );
    if (needMatch?.[1]) {
      constraints.push(cleanNaturalPhrase(needMatch[1]));
      continue;
    }
    const negativePreferenceMatch = line.match(
      /(?:^|[,:]\s*|\b)(?:i don't want|i do not want|nothing too|not too)\s+([^.;?!]+)/i
    );
    if (negativePreferenceMatch?.[1]) {
      constraints.push(`avoid ${cleanNaturalPhrase(negativePreferenceMatch[1]).replace(/^too\s+/i, "")}`);
      continue;
    }
    const avoidMatch = line.match(/(?:^|[,:]\s*|\b)(?:without|avoid)\s+([^.;?!]+)/i);
    if (avoidMatch?.[1]) {
      constraints.push(`avoid ${cleanNaturalPhrase(avoidMatch[1])}`);
    }
  }
  return constraints;
}

function extractQuestionsFromContent(content: string) {
  const lines = splitContentLines(content);
  return lines
    .filter((line) => /^question\s*:/i.test(line) || /^open question\s*:/i.test(line) || line.endsWith("?"))
    .map((line) => {
      if (/^(question|open question)\s*:/i.test(line)) {
        return normalizeLineValue(line, /^(question|open question)\s*:/i);
      }
      const segments = line.split(/\s*,\s*/).filter(Boolean);
      const tail = [...segments].reverse().find((segment) => /\b(what|why|how|when|where|which|is|are|can|could|should|would|do|does|did)\b/i.test(segment))
        ?? segments[segments.length - 1]
        ?? line;
      return cleanNaturalPhrase(tail) + (tail.trim().endsWith("?") ? "?" : "");
    })
    .filter((line) => !/^would you like me to\b/i.test(line));
}

function extractDecisionsFromContent(content: string) {
  const lines = splitContentLines(content);
  const decisions = [];
  for (const line of lines) {
    if (/\b(decide|decision|we will|agreed)\b/i.test(line)) {
      decisions.push(line.trim());
    }
  }
  return decisions;
}

function extractProgressFromContent(content: string) {
  const lines = splitContentLines(content);
  const entries = [];
  for (const line of lines) {
    if (/^(status update|status)\s*:/i.test(line)) {
      entries.push(normalizeLineValue(line, /^(status update|status)\s*:/i));
      continue;
    }
    if (/^(progress|progress summary)\s*:/i.test(line)) {
      entries.push(normalizeLineValue(line, /^(progress|progress summary)\s*:/i));
      continue;
    }

    const clauses = splitNaturalClauses(line);
    for (const clause of clauses) {
      if (clause.endsWith("?")) continue;
      if (/^i weigh\b/i.test(clause)) {
        entries.push(cleanNaturalPhrase(clause));
        continue;
      }
      if (/^(?:i am|i'm)\s+\d{1,3}\b/i.test(clause)) {
        entries.push(cleanNaturalPhrase(clause));
        continue;
      }
      if (/^(?:i have|i've|i have been|i've been|i am dealing with|i'm dealing with)\b/i.test(clause)) {
        entries.push(cleanNaturalPhrase(clause));
        continue;
      }
      if (/^(?:currently|right now)\b/i.test(clause) || /\b(?:currently|right now)\b/i.test(clause)) {
        entries.push(cleanNaturalPhrase(clause));
        continue;
      }
      if (/^(?:i already|i've already|i have already)\b/i.test(clause)) {
        entries.push(cleanNaturalPhrase(clause));
      }
    }
  }
  return entries;
}

function shouldUseForWorkingMemory(event: WorkingMemoryEventLike) {
  if (event.role === "assistant") {
    return false;
  }
  if (/^assistant reply:/i.test(event.content.trim())) {
    return false;
  }
  return true;
}

export function selectWorkingMemoryEvents(
  events: WorkingMemoryEventLike[],
  maxEvents: number
) {
  const cappedMaxEvents = Math.max(1, maxEvents);
  const ordered = [...events]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .filter(shouldUseForWorkingMemory);
  const recent = ordered.slice(-cappedMaxEvents);
  const selected = new Map(recent.map((event) => [event.id, event]));

  const latestGoalEvent = [...ordered]
    .reverse()
    .find((event) => extractGoalFromContent(event.content));

  if (latestGoalEvent) {
    selected.set(latestGoalEvent.id, latestGoalEvent);
  }

  return [...selected.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function extractWorkingMemoryState(
  events: WorkingMemoryEventLike[],
  options?: WorkingMemoryExtractorOptions
): WorkingMemoryState {
  const maxItems = Math.max(1, options?.maxItemsPerField ?? 10);
  const ordered = selectWorkingMemoryEvents(events, events.length);
  const reversed = [...ordered].reverse();

  let currentGoal: string | undefined;
  const constraints = [];
  const decisions = [];
  const openQuestions = [];
  const progress = [];
  const sourceEventIds = [];

  for (const event of ordered) {
    sourceEventIds.push(event.id);
    constraints.push(...extractConstraintsFromContent(event.content));
    openQuestions.push(...extractQuestionsFromContent(event.content));
    decisions.push(...extractDecisionsFromContent(event.content));
    progress.push(...extractProgressFromContent(event.content));
  }

  for (const event of reversed) {
    const goal = extractGoalFromContent(event.content);
    if (goal) {
      currentGoal = goal;
      break;
    }
  }

  const dedupedConstraints = uniq(constraints).slice(-maxItems);
  const dedupedDecisions = uniq(decisions).slice(-maxItems);
  const dedupedQuestions = uniq(openQuestions).slice(-maxItems);
  const dedupedProgress = uniq(progress).slice(-3);

  const fallbackTaskFrame = currentGoal
    || dedupedProgress[dedupedProgress.length - 1]
    || dedupedDecisions[dedupedDecisions.length - 1]
    || dedupedConstraints[0]
    || undefined;

  return {
    currentGoal,
    activeConstraints: dedupedConstraints,
    recentDecisions: dedupedDecisions,
    progressSummary: dedupedProgress.length ? dedupedProgress.join(" | ") : undefined,
    openQuestions: dedupedQuestions,
    taskFrame: fallbackTaskFrame,
    sourceEventIds: uniq(sourceEventIds).slice(-Math.max(maxItems * 2, 10))
  };
}

export function mergeWorkingMemoryState(
  base: WorkingMemoryState,
  patch?: PartialWorkingMemoryState | null,
  options?: WorkingMemoryExtractorOptions
): WorkingMemoryState {
  if (!patch) return base;
  const maxItems = Math.max(1, options?.maxItemsPerField ?? 10);

  return {
    currentGoal: patch.currentGoal?.trim() || base.currentGoal,
    activeConstraints: uniq([...(base.activeConstraints ?? []), ...(patch.activeConstraints ?? [])]).slice(-maxItems),
    recentDecisions: uniq([...(base.recentDecisions ?? []), ...(patch.recentDecisions ?? [])]).slice(-maxItems),
    progressSummary: patch.progressSummary?.trim() || base.progressSummary,
    openQuestions: uniq([...(base.openQuestions ?? []), ...(patch.openQuestions ?? [])]).slice(-maxItems),
    taskFrame: patch.taskFrame?.trim() || base.taskFrame || patch.currentGoal?.trim() || base.currentGoal,
    sourceEventIds: uniq([...(base.sourceEventIds ?? []), ...(patch.sourceEventIds ?? [])]).slice(-Math.max(maxItems * 2, 10))
  };
}
