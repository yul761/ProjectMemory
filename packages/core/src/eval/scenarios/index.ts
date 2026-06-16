export { longRunningProject } from "./long-running-project";
export { decisionRevision } from "./decision-revision";
export { goalStability } from "./goal-stability";
export { retrievalQuality } from "./retrieval-quality";

import { longRunningProject } from "./long-running-project";
import { decisionRevision } from "./decision-revision";
import { goalStability } from "./goal-stability";
import { retrievalQuality } from "./retrieval-quality";
import type { EvalScenario } from "../types";

export const scenarios: EvalScenario[] = [
  longRunningProject,
  decisionRevision,
  goalStability,
  retrievalQuality
];
