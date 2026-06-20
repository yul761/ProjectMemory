import type { WorkingMemoryState } from "./working-memory.extractor";

type PartialDigestState = {
  stableFacts?: {
    goal?: string;
    constraints?: string[];
    decisions?: string[];
  };
  todos?: string[];
  workingNotes?: {
    openQuestions?: string[];
    risks?: string[];
  };
  profile?: {
    identity?: string[];
    relationships?: string[];
    ongoing?: string[];
    goals?: string[];
    followUps?: string[];
  };
} | null;

export interface WorkingMemoryView {
  goal?: string;
  constraints: string[];
  decisions: string[];
  progressSummary?: string;
  openQuestions: string[];
  taskFrame?: string;
}

export interface StateLayerView {
  goal?: string;
  constraints: string[];
  decisions: string[];
  todos: string[];
  openQuestions: string[];
  risks: string[];
  identity?: string[];
  relationships?: string[];
  ongoing?: string[];
  goals?: string[];
  followUps?: string[];
}

export function compileWorkingMemoryView(state?: WorkingMemoryState | null, scopeGoal?: string | null): WorkingMemoryView {
  return {
    goal: state?.currentGoal || scopeGoal || undefined,
    constraints: state?.activeConstraints ?? [],
    decisions: state?.recentDecisions ?? [],
    progressSummary: state?.progressSummary,
    openQuestions: state?.openQuestions ?? [],
    taskFrame: state?.taskFrame
  };
}

export function compileStateLayerView(state?: PartialDigestState): StateLayerView {
  return {
    goal: state?.stableFacts?.goal,
    constraints: state?.stableFacts?.constraints ?? [],
    decisions: state?.stableFacts?.decisions ?? [],
    todos: state?.todos ?? [],
    openQuestions: state?.workingNotes?.openQuestions ?? [],
    risks: state?.workingNotes?.risks ?? [],
    identity: state?.profile?.identity,
    relationships: state?.profile?.relationships,
    ongoing: state?.profile?.ongoing,
    goals: state?.profile?.goals,
    followUps: state?.profile?.followUps
  };
}

function pushSection(lines: string[], title: string, items?: string[] | null) {
  const normalized = (items ?? []).map((item) => item.trim()).filter(Boolean);
  if (!normalized.length) return;
  lines.push(`${title}:`);
  for (const item of normalized) {
    lines.push(`- ${item}`);
  }
}

export function formatWorkingMemoryView(view?: WorkingMemoryView | null) {
  if (!view) return "(none)";
  const lines = [];
  if (view.goal) lines.push(`Current goal: ${view.goal}`);
  pushSection(lines, "Active constraints", view.constraints);
  pushSection(lines, "Recent decisions", view.decisions);
  if (view.progressSummary) lines.push(`Progress summary: ${view.progressSummary}`);
  pushSection(lines, "Open questions", view.openQuestions);
  if (view.taskFrame) lines.push(`Task frame: ${view.taskFrame}`);
  return lines.length ? lines.join("\n") : "(none)";
}

export function formatStateLayerView(view?: StateLayerView | null) {
  if (!view) return "(none)";
  const lines = [];
  if (view.goal) lines.push(`Stable goal: ${view.goal}`);
  pushSection(lines, "Stable constraints", view.constraints);
  pushSection(lines, "Stable decisions", view.decisions);
  pushSection(lines, "Durable todos", view.todos);
  pushSection(lines, "Open questions", view.openQuestions);
  pushSection(lines, "Risks", view.risks);
  pushSection(lines, "你是谁/档案", view.identity);
  pushSection(lines, "人际", view.relationships);
  pushSection(lines, "正在经历", view.ongoing);
  pushSection(lines, "目标", view.goals);
  pushSection(lines, "待跟进", view.followUps);
  return lines.length ? lines.join("\n") : "(none)";
}
