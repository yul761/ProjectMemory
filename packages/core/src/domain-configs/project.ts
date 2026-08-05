import type { DomainConfig } from "./types";
import type { FacetPack } from "../facet-registry";

// Facets for the project domain. routesFrom names this domain's own classifier
// entity types, which is what makes stage 1 actually land somewhere.
export const projectFacetPack: FacetPack = {
  name: "project",
  facets: [
    { name: "decisions", cap: 20, writeProtected: true, displayGroup: "Decisions",
      routesFrom: ["decision"],
      description: 'technical or product decisions the team has reached (e.g. "use Postgres for storage").' },
    { name: "constraints", cap: 15, writeProtected: true, displayGroup: "Constraints",
      routesFrom: ["constraint"],
      description: 'boundaries or requirements the project must respect (e.g. "self-hosted only", "ship before Q3").' },
    { name: "todos", cap: 20, writeProtected: false, displayGroup: "Todos",
      routesFrom: ["todo"],
      description: "concrete action items still to be completed." },
    { name: "openQuestions", cap: 15, writeProtected: false, displayGroup: "Questions",
      routesFrom: ["question"],
      description: "questions raised and not yet resolved." },
    { name: "status", cap: 10, writeProtected: false, displayGroup: "Status",
      routesFrom: ["status"],
      description: "progress updates on the work." },
    { name: "notes", cap: 30, writeProtected: false, displayGroup: "Notes",
      description: "durable project or product details worth keeping long-term." }
  ]
};

export const projectConfig: DomainConfig = {
  facetPack: projectFacetPack,
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
