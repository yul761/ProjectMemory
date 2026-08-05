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
  /**
   * Fact-registry observation.
   *
   * The metrics above cover stableFacts only — decisions, constraints, goal,
   * todos. User facts live in the profile facets and their registry entries, so
   * a drift score computed without these was measuring a data model the facts
   * were not in, and could report perfect stability while the fact store churned.
   */
  factsAdded: number;
  factsRetired: number;
  factsSuperseded: number;
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
  const registryDrift = computeRegistryDrift(before, after);

  if (!before) {
    return {
      goalChanged: false,
      decisionsAdded: 0,
      decisionsRemoved: 0,
      constraintsAdded: 0,
      constraintsRemoved: 0,
      todosAdded: 0,
      todosRemoved: 0,
      stabilityScore: 1,
      ...registryDrift
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
    stabilityScore,
    ...registryDrift
  };
}

/**
 * Counts registry transitions that happened during this run.
 *
 * Entries are compared by id: a fact whose id was not present before is new, and
 * a fact that gained `retiredAt` / `supersededBy` during this run transitioned.
 * Comparing by id rather than by presence keeps an already-retired fact from
 * being re-counted on every subsequent digest.
 */
function computeRegistryDrift(
  before: DigestState | null,
  after: DigestState
): Pick<DriftMetrics, "factsAdded" | "factsRetired" | "factsSuperseded"> {
  const afterEntries = after.factRegistry ?? [];
  const beforeById = new Map((before?.factRegistry ?? []).map((entry) => [entry.id, entry]));

  let factsAdded = 0;
  let factsRetired = 0;
  let factsSuperseded = 0;

  for (const entry of afterEntries) {
    const previous = beforeById.get(entry.id);
    if (!previous) factsAdded++;
    if (entry.retiredAt && !previous?.retiredAt) factsRetired++;
    if (entry.supersededBy && !previous?.supersededBy) factsSuperseded++;
  }

  return { factsAdded, factsRetired, factsSuperseded };
}
