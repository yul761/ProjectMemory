import type { DomainConfig } from "./types";

export const projectConfig: DomainConfig = {
  name: "project",
  description: "Engineering and product project memory — technical decisions, constraints, and todos",
  entityTypes: [
    { name: "decision",   description: "Technical or product decision reached by the team", retention: "permanent",  driftProtected: true,  conflictDetectable: true  },
    { name: "constraint", description: "A boundary or requirement the project must respect",  retention: "permanent",  driftProtected: true,  conflictDetectable: false },
    { name: "todo",       description: "A concrete action item to be completed",              retention: "long-term", driftProtected: false, conflictDetectable: false },
    { name: "question",   description: "An open question not yet resolved",                   retention: "medium",    driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 30  },
    { name: "status",     description: "A progress or status update",                         retention: "short",     driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 14  },
    { name: "noise",      description: "Filler content with no informational value",           retention: "discard",   driftProtected: false, conflictDetectable: false }
  ],
  classificationSystemPrompt: `You are a project memory classifier. Classify the input into one of:
- decision: technical or product decision (contains decide/decision/we will/agreed/going with)
- constraint: boundary or requirement (contains constraint/must/cannot/required/no X allowed)
- todo: action item (contains todo/next step/action item/follow up/let's add/make sure to)
- question: open question
- status: progress update
- noise: filler with no value (ok/noted/thanks/short chatter)

Return JSON: { "entityType": string, "importance": number }
importance is 0-1 (decision/constraint=0.8+, todo=0.7, status/question=0.5, noise=0.05)`,
  digestFocusHint: "Focus on project goals, technical decisions, constraints, and open todos"
};
