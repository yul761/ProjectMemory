import type { DigestState } from "./digest-control";

export interface DriftMetrics {
  goalChanged: boolean;
  decisionsAdded: number;
  decisionsRemoved: number;
  constraintsAdded: number;
  constraintsRemoved: number;
  todosAdded: number;
  todosRemoved: number;
  stabilityScore: number;
}

function countAdded(before: string[], after: string[]): number {
  const beforeSet = new Set(before);
  return after.filter((item) => !beforeSet.has(item)).length;
}

function countRemoved(before: string[], after: string[]): number {
  const afterSet = new Set(after);
  return before.filter((item) => !afterSet.has(item)).length;
}

export function computeDriftMetrics(
  before: DigestState | null,
  after: DigestState
): DriftMetrics {
  if (!before) {
    return {
      goalChanged: false,
      decisionsAdded: 0,
      decisionsRemoved: 0,
      constraintsAdded: 0,
      constraintsRemoved: 0,
      todosAdded: 0,
      todosRemoved: 0,
      stabilityScore: 1
    };
  }

  const beforeDecisions = before.stableFacts.decisions ?? [];
  const afterDecisions = after.stableFacts.decisions ?? [];
  const beforeConstraints = before.stableFacts.constraints ?? [];
  const afterConstraints = after.stableFacts.constraints ?? [];
  const beforeTodos = before.todos ?? [];
  const afterTodos = after.todos ?? [];

  const goalChanged = (before.stableFacts.goal ?? "") !== (after.stableFacts.goal ?? "");
  const decisionsAdded = countAdded(beforeDecisions, afterDecisions);
  const decisionsRemoved = countRemoved(beforeDecisions, afterDecisions);
  const constraintsAdded = countAdded(beforeConstraints, afterConstraints);
  const constraintsRemoved = countRemoved(beforeConstraints, afterConstraints);
  const todosAdded = countAdded(beforeTodos, afterTodos);
  const todosRemoved = countRemoved(beforeTodos, afterTodos);

  const trackedItems = Math.max(
    1,
    beforeDecisions.length + beforeConstraints.length + (before.stableFacts.goal ? 1 : 0)
  );
  const changedItems =
    decisionsAdded + decisionsRemoved +
    constraintsAdded + constraintsRemoved +
    (goalChanged ? 1 : 0);
  const stabilityScore = Math.max(0, 1 - changedItems / trackedItems);

  return {
    goalChanged,
    decisionsAdded,
    decisionsRemoved,
    constraintsAdded,
    constraintsRemoved,
    todosAdded,
    todosRemoved,
    stabilityScore
  };
}
