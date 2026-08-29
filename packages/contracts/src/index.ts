import { z } from "zod";

// Shared primitives
export const ProjectStage = z.enum(["idea", "build", "test", "launch"]);
export type ProjectStage = z.infer<typeof ProjectStage>;

export const MemoryType = z.enum(["stream", "document"]);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemorySource = z.enum(["telegram", "cli", "api", "sdk"]);
export type MemorySource = z.infer<typeof MemorySource>;

export const ReminderStatus = z.enum(["scheduled", "sent", "cancelled"]);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

// Scope/session contracts
export const ScopeCreateInput = z.object({
  name: z.string().min(1),
  goal: z.string().min(1).optional(),
  stage: ProjectStage.optional(),
  template: z.enum(["project", "personal", "health", "learning"]).optional()
});

export const ScopeOutput = z.object({
  id: z.string().uuid(),
  name: z.string(),
  goal: z.string().nullable(),
  stage: ProjectStage,
  createdAt: z.string()
});

export const ScopeListOutput = z.object({
  items: z.array(ScopeOutput)
});

export const ActiveScopeInput = z.object({
  scopeId: z.string().uuid().nullable()
});

export const StateOutput = z.object({
  activeScopeId: z.string().uuid().nullable()
});

export const ScopeActivationOutput = z.object({
  activeScopeId: z.string().uuid().nullable()
});

// Internal control surface contracts
export const MemoryEventInput = z.object({
  scopeId: z.string().uuid(),
  type: MemoryType,
  source: MemorySource.optional(),
  key: z.string().min(1).optional(),
  content: z.string().min(1),
  // When the event actually happened, if it differs from ingest time. Lets callers
  // replay historical conversations without collapsing them onto "now" — which
  // otherwise destroys any time-based reasoning over the resulting memory.
  occurredAt: z.string().datetime({ offset: true }).optional(),
  // "Must not lose a budget competition." The engine cannot tell a resume from a
  // meeting note; without this its only tiebreaker is recency, which drops
  // durable inputs first because they are by definition the oldest.
  pinned: z.boolean().optional()
}).superRefine((input, ctx) => {
  if (input.type === "document" && !input.key) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "key is required for document events" });
  }
});

export const MemoryEventOutput = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  scopeId: z.string().uuid(),
  type: MemoryType,
  source: MemorySource,
  key: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  pinned: z.boolean().optional()
});

export const MemoryEventListOutput = z.object({
  items: z.array(MemoryEventOutput),
  nextCursor: z.string().nullable()
});

export const DigestRequestInput = z.object({
  scopeId: z.string().uuid()
});

export const DigestOutput = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid(),
  summary: z.string(),
  changes: z.string(),
  nextSteps: z.array(z.string()),
  createdAt: z.string(),
  rebuildGroupId: z.string().uuid().nullable().optional()
});

export const DigestListOutput = z.object({
  items: z.array(DigestOutput),
  nextCursor: z.string().nullable()
});

export const DigestEnqueueOutput = z.object({
  jobId: z.string()
});

export const DigestRebuildOutput = z.object({
  jobId: z.string(),
  rebuildGroupId: z.string().uuid()
});

export const DigestRebuildInput = z.object({
  scopeId: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  strategy: z.enum(["full", "since_last_good"]).optional()
});

// Debug surface contracts
export const RetrieveInput = z.object({
  scopeId: z.string().uuid(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  // Optional by contract rule: /v1 is an additively-compatible freeze, so a new
  // field is never required. Absent means "behave exactly as before".
  maxChars: z.number().int().positive().optional()
});

export const FactRegistryEntrySchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.enum(["decision", "constraint", "profile"]),
  confidence: z.number().min(0).max(1),
  addedAt: z.string(),
  evidenceId: z.string(),
  evidenceType: z.enum(["event", "document"]),
  supersededBy: z.string().optional(),
  facet: z.string().optional(),
  // Additive and optional: a fact that left the active set without a replacement
  // (capacity eviction, explicit forget). Absent on every pre-existing entry.
  retiredAt: z.string().optional(),
  retiredReason: z.string().optional()
});

export const BudgetDropSchema = z.object({
  kind: z.enum(["digest", "fact", "event"]),
  id: z.string().nullable(),
  chars: z.number().int().min(0),
  reason: z.enum(["budget_exhausted", "fact_share_cap", "digest_too_large"]),
  score: z.number().optional()
});

export const BudgetReportSchema = z.object({
  maxChars: z.number().int().min(0),
  usedChars: z.number().int().min(0),
  digestChars: z.number().int().min(0),
  factChars: z.number().int().min(0),
  eventChars: z.number().int().min(0),
  factShareCap: z.number().int().min(0),
  // Counts are exact and never truncated; `dropped` is the bounded detail.
  droppedCounts: z.object({
    digest: z.number().int().min(0),
    fact: z.number().int().min(0),
    event: z.number().int().min(0)
  }),
  dropped: z.array(BudgetDropSchema),
  itemsOmitted: z.number().int().min(0)
});

export const RetrieveOutput = z.object({
  digest: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.string().uuid(),
      content: z.string(),
      createdAt: z.string()
    })
  ),
  factRegistry: z.array(FactRegistryEntrySchema),
  // Top-level, not nested in `retrieval`: the budget is a statement about the
  // response as a whole (did everything the caller asked for fit?), not a
  // ranking diagnostic. `retrieval` legitimately does not exist when the caller
  // sent no query, and `budget` must not depend on a container that can be
  // absent — see the no-query + maxChars integration test for the failure this
  // avoids (spreading `undefined` used to produce a `retrieval` object missing
  // its seven required fields, which parseOutput rejected as a 500).
  budget: BudgetReportSchema.optional(),
  retrieval: z.object({
    // `mode` states what actually ran, not what was configured: embedding
    // failures downgrade it to "heuristic" and are itemised in `degraded`.
    mode: z.enum(["heuristic", "hybrid"]),
    // Additive and optional: embedding-backed stages that failed during this
    // retrieve. Absent means every configured stage completed.
    degraded: z
      .array(
        z.object({
          stage: z.enum(["vector_search", "rerank"]),
          error: z.string()
        })
      )
      .optional(),
    embeddingRequested: z.boolean(),
    embeddingConfigured: z.boolean(),
    reranked: z.boolean(),
    candidateCount: z.number().int().min(0),
    returnedCount: z.number().int().min(0),
    embeddingCandidateLimit: z.number().int().min(0).optional(),
    matches: z.array(z.object({
      id: z.string().uuid(),
      sourceType: MemoryType,
      key: z.string().nullable().optional(),
      heuristicScore: z.number(),
      recencyScore: z.number(),
      embeddingScore: z.number().optional(),
      finalScore: z.number(),
      rankingReason: z.string()
    }))
  }).optional()
});

export const MemoryFactsOutput = z.object({
  groups: z.array(
    z.object({
      group: z.string(),
      items: z.array(
        z.object({
          factKey: z.string(),
          text: z.string(),
          createdAt: z.string().nullable()
        })
      )
    })
  )
});

export const ForgetFactInput = z.object({
  scopeId: z.string().uuid(),
  factKey: z.string().min(1)
});

export const AddNoteInput = z.object({
  scopeId: z.string().uuid(),
  text: z.string().min(1).max(500)
});

export const ScopeIdQuery = z.object({ scopeId: z.string().uuid() });
// `GET /facet-pack` answers for the account when no scope is named, so its
// scopeId is optional where every other reader's is required.
export const OptionalScopeIdQuery = z.object({ scopeId: z.string().uuid().optional() });
export const MemoryForgetOutput = z.object({ ok: z.boolean() });
export const AddNoteOutput = z.object({ ok: z.boolean() });

// One facet of the active pack, as the engine will treat it: how many facts it
// holds, whether conversation may overwrite them, whether it takes facts only
// from documents, and which classifier types route into it. A caller reading
// `GET /memory/facts` needs this to know why a fact is where it is — or missing.
export const FacetDefinitionOutput = z.object({
  name: z.string(),
  cap: z.number().int().min(0),
  writeProtected: z.boolean(),
  documentAuthority: z.boolean(),
  // null means the facet is never surfaced through the display API.
  displayGroup: z.string().nullable(),
  routesFrom: z.array(z.string()),
  description: z.string()
});

export const FacetPackOutput = z.object({
  name: z.string(),
  // True when the account has installed no pack of its own.
  isDefault: z.boolean(),
  // Which layer decided the ontology. An open set per compatibility rule 3: a
  // future resolution layer adds a value here without breaking `/v1`.
  source: z.enum(["template", "account", "deployment-default"]),
  template: z.string().nullable(),
  facets: z.array(FacetDefinitionOutput)
});

// A fact's evidence plus every version of it, oldest first. `FactRegistryEntrySchema`
// is the same entry shape `RetrieveOutput.factRegistry` already froze, so a caller
// holding an id from a retrieval can hand it straight back here.
export const FactProvenanceOutput = z.object({
  fact: FactRegistryEntrySchema,
  chain: z.array(FactRegistryEntrySchema)
});

export const DigestSelectionOutput = z.object({
  rationale: z.array(z.string()),
  // Deliberately unshaped. The handler reads JSON written by whichever version of
  // the digest pipeline ran, and normalises only the two top-level arrays; drop
  // records carry an open `reason` set and a free-form `detail`. Declaring a shape
  // here would promise validation the endpoint does not perform.
  drops: z.array(z.unknown())
});
export const ScopeDeleteOutput = z.object({ ok: z.boolean() });

// What a caller needs to open a conversation that sounds like it remembers the
// person: how long we have known them, what they are working toward, how they
// felt recently, and what they said a while ago that nobody has circled back to.
//
// `personaPrompt` is deliberately absent from the frozen subset — see the note
// on the contract registry entry.
export const RelationshipContextOutput = z.object({
  durationDays: z.number().int().nonnegative(),
  personalDetails: z.array(z.string()),
  activeGoals: z.array(z.string()),
  currentFeeling: z.string().nullable(),
  pendingFollowUps: z.array(z.string())
});

export const AnswerInput = z.object({
  scopeId: z.string().uuid(),
  question: z.string().min(1)
});

export const GroundingEvidenceOutput = z.object({
  digestIds: z.array(z.string()),
  eventIds: z.array(z.string()),
  stateRefs: z.array(z.string()),
  digestSummary: z.string().nullable().optional(),
  eventSnippets: z.array(z.object({
    id: z.string(),
    createdAt: z.string(),
    snippet: z.string(),
    sourceType: MemoryType.optional(),
    key: z.string().nullable().optional(),
    rankingReason: z.string().optional(),
    heuristicScore: z.number().optional(),
    recencyScore: z.number().optional(),
    embeddingScore: z.number().optional(),
    finalScore: z.number().optional()
  })).optional(),
  stateSummary: z.string().nullable().optional(),
  stateDetails: z.object({
    digestId: z.string().nullable(),
    goal: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    todos: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    confidence: z.object({
      goal: z.number().min(0).max(1).optional(),
      constraints: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
      decisions: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
      todos: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional()
    }).optional(),
    provenanceFields: z.array(z.string()).optional(),
    transitionTaxonomy: z.record(z.string(), z.number()).optional(),
    recentChanges: z.array(z.object({
      field: z.enum(["goal", "constraints", "decisions", "todos", "volatileContext", "openQuestions", "risks"]).optional(),
      action: z.enum(["set", "add", "remove", "reaffirm"]).optional(),
      value: z.string().optional()
    })).optional()
  }).nullable().optional()
});

export const AnswerOutput = z.object({
  answer: z.string(),
  evidence: GroundingEvidenceOutput.optional()
});

export const RuntimeTurnInput = z.object({
  scopeId: z.string().uuid(),
  message: z.string().min(1),
  source: MemorySource.optional(),
  policyProfile: z.enum(["default", "conservative", "document-heavy"]).optional(),
  policyOverrides: z.object({
    recallLimit: z.number().int().min(1).max(100).optional(),
    promoteLongFormToDocumented: z.boolean().optional(),
    digestOnCandidate: z.boolean().optional()
  }).optional(),
  writeTier: z.enum(["ephemeral", "candidate", "stable", "documented"]).optional(),
  documentKey: z.string().min(1).optional(),
  digestMode: z.enum(["auto", "force", "skip"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeTurnOutput = z.object({
  answer: z.string(),
  answerMode: z.enum(["direct_state_fast_path", "llm_fast_path"]).optional(),
  writeTier: z.enum(["ephemeral", "candidate", "stable", "documented"]),
  digestTriggered: z.boolean(),
  workingMemoryVersion: z.number().int().min(0).nullable().optional(),
  stableStateVersion: z.string().nullable().optional(),
  usedFastLayerContextSummary: z.string().optional(),
  retrievalPlan: z.object({
    mode: z.enum(["none", "light", "full"]),
    reason: z.string(),
    limit: z.number().int().min(0),
    query: z.string().optional(),
    cacheHit: z.boolean().optional()
  }).optional(),
  layerAlignment: z.object({
    goalAligned: z.boolean(),
    sharedConstraintCount: z.number().int().min(0),
    sharedDecisionCount: z.number().int().min(0),
    fastPathReady: z.boolean()
  }).optional(),
  warnings: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  evidence: GroundingEvidenceOutput
});

export const WorkingMemoryState = z.object({
  currentGoal: z.string().optional(),
  activeConstraints: z.array(z.string()),
  recentDecisions: z.array(z.string()),
  progressSummary: z.string().optional(),
  openQuestions: z.array(z.string()),
  taskFrame: z.string().optional(),
  sourceEventIds: z.array(z.string())
});
export type WorkingMemoryState = z.infer<typeof WorkingMemoryState>;

export const WorkingMemoryView = z.object({
  goal: z.string().optional(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  progressSummary: z.string().optional(),
  openQuestions: z.array(z.string()),
  taskFrame: z.string().optional()
});
export type WorkingMemoryView = z.infer<typeof WorkingMemoryView>;

export const StateLayerView = z.object({
  goal: z.string().optional(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  todos: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  identity: z.array(z.string()).optional(),
  relationships: z.array(z.string()).optional(),
  ongoing: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional()
});
export type StateLayerView = z.infer<typeof StateLayerView>;

export const FastLayerContext = z.object({
  systemContext: z.string(),
  workingMemoryBlock: z.string(),
  stableStateBlock: z.string(),
  retrievalBlock: z.string(),
  recentTurnsBlock: z.string(),
  retrievalHints: z.object({
    priorityTerms: z.array(z.string()),
    exclusions: z.array(z.string())
  }),
  summary: z.string()
});
export type FastLayerContext = z.infer<typeof FastLayerContext>;

export const RetrievalPlanOutput = z.object({
  mode: z.enum(["none", "light", "full"]),
  reason: z.string(),
  limit: z.number().int().min(0),
  query: z.string().optional(),
  cacheHit: z.boolean().optional()
});
export type RetrievalPlanOutput = z.infer<typeof RetrievalPlanOutput>;

export const WorkingMemoryOutput = z.object({
  scopeId: z.string().uuid(),
  version: z.number().int().min(0),
  state: WorkingMemoryState.nullable(),
  view: WorkingMemoryView.nullable(),
  updatedAt: z.string().nullable()
});

export const FastLayerViewOutput = z.object({
  scopeId: z.string().uuid(),
  workingMemoryVersion: z.number().int().min(0).nullable(),
  stableStateVersion: z.string().nullable(),
  retrievalPlan: RetrievalPlanOutput.nullable().optional(),
  fastLayerContext: FastLayerContext
});

export const ReminderCreateInput = z.object({
  scopeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime(),
  text: z.string().min(1)
});

export const ReminderOutput = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid().nullable(),
  dueAt: z.string(),
  text: z.string(),
  status: ReminderStatus,
  createdAt: z.string()
});

export const ReminderListOutput = z.object({
  items: z.array(ReminderOutput),
  nextCursor: z.string().nullable()
});

export const ReminderCancelOutput = z.object({
  ok: z.boolean()
});

export const HealthOutput = z.object({
  status: z.literal("ok"),
  featureLlm: z.boolean().optional(),
  workingMemory: z.object({
    enabled: z.boolean(),
    useLlm: z.boolean(),
    maxRecentTurns: z.number().int().min(1),
    maxItemsPerField: z.number().int().min(1)
  }).optional(),
  retrieve: z.object({
    useEmbeddings: z.boolean(),
    useVectorSearch: z.boolean().optional(),
    embeddingCandidateLimit: z.number().int().min(1)
  }).optional(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    baseUrl: z.string(),
    chatModel: z.string(),
    runtimeModel: z.string().optional(),
    runtimeModelBaseUrl: z.string().optional(),
    runtimeReasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    runtimeMaxOutputTokens: z.number().int().min(1).optional(),
    structuredOutputModel: z.string(),
    embeddingModel: z.string().nullable()
  }).optional()
});

// Internal digest control layer models (not API payloads)
export const MemoryEventKind = z.enum(["decision", "constraint", "todo", "note", "status", "question", "noise"]);
export type MemoryEventKind = z.infer<typeof MemoryEventKind>;

export const EventFeatures = z.object({
  kind: MemoryEventKind,
  importanceScore: z.number().min(0).max(1),
  noveltyScore: z.number().min(0).max(1),
  docKey: z.string().optional(),
  references: z.array(z.string()).optional()
});
export type EventFeatures = z.infer<typeof EventFeatures>;

export const DigestState = z.object({
  stableFacts: z.object({
    goal: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    decisions: z.array(z.string())
  }),
  workingNotes: z.object({
    openQuestions: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    context: z.string().optional()
  }),
  todos: z.array(z.string()),
  volatileContext: z.array(z.string()).optional(),
  evidenceRefs: z.array(z.object({
    id: z.string(),
    sourceType: z.enum(["document", "event"]),
    key: z.string().optional(),
    kind: MemoryEventKind.optional()
  })).optional(),
  confidence: z.object({
    goal: z.number().min(0).max(1).optional(),
    constraints: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
    decisions: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
    todos: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
    volatileContext: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
    openQuestions: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional(),
    risks: z.array(z.object({ value: z.string(), score: z.number().min(0).max(1) })).optional()
  }).optional(),
  provenance: z.object({
    goal: z.array(z.object({
      id: z.string(),
      sourceType: z.enum(["document", "event"]),
      key: z.string().optional(),
      kind: MemoryEventKind.optional()
    })).optional(),
    constraints: z.array(z.object({
      value: z.string(),
      refs: z.array(z.object({
        id: z.string(),
        sourceType: z.enum(["document", "event"]),
        key: z.string().optional(),
        kind: MemoryEventKind.optional()
      }))
    })).optional(),
    decisions: z.array(z.object({
      value: z.string(),
      refs: z.array(z.object({
        id: z.string(),
        sourceType: z.enum(["document", "event"]),
        key: z.string().optional(),
        kind: MemoryEventKind.optional()
      }))
    })).optional(),
    todos: z.array(z.object({
      value: z.string(),
      refs: z.array(z.object({
        id: z.string(),
        sourceType: z.enum(["document", "event"]),
        key: z.string().optional(),
        kind: MemoryEventKind.optional()
      }))
    })).optional(),
    volatileContext: z.array(z.object({
      value: z.string(),
      refs: z.array(z.object({
        id: z.string(),
        sourceType: z.enum(["document", "event"]),
        key: z.string().optional(),
        kind: MemoryEventKind.optional()
      }))
    })).optional(),
    openQuestions: z.array(z.object({
      value: z.string(),
      refs: z.array(z.object({
        id: z.string(),
        sourceType: z.enum(["document", "event"]),
        key: z.string().optional(),
        kind: MemoryEventKind.optional()
      }))
    })).optional(),
    risks: z.array(z.object({
      value: z.string(),
      refs: z.array(z.object({
        id: z.string(),
        sourceType: z.enum(["document", "event"]),
        key: z.string().optional(),
        kind: MemoryEventKind.optional()
      }))
    })).optional()
  }).optional(),
  transitionSummary: z.record(z.string(), z.number()).optional(),
  recentChanges: z.array(z.object({
    field: z.enum(["goal", "constraints", "decisions", "todos", "volatileContext", "openQuestions", "risks"]),
    action: z.enum(["set", "add", "remove", "reaffirm"]),
    value: z.string(),
    evidence: z.object({
      id: z.string(),
      sourceType: z.enum(["document", "event"]),
      key: z.string().optional(),
      kind: MemoryEventKind.optional()
    })
  })).optional(),
  profile: z.object({
    identity: z.array(z.string()).optional(),
    relationships: z.array(z.string()).optional(),
    ongoing: z.array(z.string()).optional(),
    goals: z.array(z.string()).optional(),
    followUps: z.array(z.string()).optional(),
    style: z.array(z.string()).optional()
  }).optional()
});
export type DigestState = z.infer<typeof DigestState>;

export const StableStateOutput = z.object({
  digestId: z.string().nullable(),
  state: DigestState.nullable(),
  view: StateLayerView.nullable(),
  consistency: z.unknown().nullable().optional(),
  createdAt: z.string().nullable()
});

export const DigestStateOutput = z.object({
  digestId: z.string().nullable(),
  state: DigestState.nullable(),
  consistency: z.unknown().nullable().optional(),
  createdAt: z.string().nullable()
});

export const DigestStateHistoryOutput = z.object({
  items: z.array(z.object({
    digestId: z.string(),
    state: DigestState,
    consistency: z.unknown().nullable().optional(),
    createdAt: z.string()
  }))
});

export const LayerAlignmentOutput = z.object({
  goalAligned: z.boolean(),
  sharedConstraintCount: z.number().int().min(0),
  sharedDecisionCount: z.number().int().min(0),
  fastPathReady: z.boolean()
});

export const LayerFreshnessOutput = z.object({
  latestEventCreatedAt: z.string().nullable(),
  workingMemoryUpdatedAt: z.string().nullable(),
  stableStateCreatedAt: z.string().nullable(),
  workingMemoryLagMs: z.number().int().min(0).nullable(),
  stableStateLagMs: z.number().int().min(0).nullable(),
  workingMemoryCaughtUp: z.boolean(),
  stableStateCaughtUp: z.boolean()
});

export const LayerStatusOutput = z.object({
  scopeId: z.string().uuid(),
  message: z.string(),
  workingMemoryVersion: z.number().int().min(0).nullable(),
  stableStateVersion: z.string().nullable(),
  workingMemoryView: WorkingMemoryView.nullable(),
  stableStateView: StateLayerView.nullable(),
  fastLayerSummary: z.string(),
  retrievalPlan: RetrievalPlanOutput.nullable().optional(),
  layerAlignment: LayerAlignmentOutput,
  freshness: LayerFreshnessOutput,
  warnings: z.array(z.string())
});

// Grouped API surface contracts
// These maps exist so a demo app or SDK can import the intended contract
// boundary directly instead of depending on the entire file as one flat list.
export const PublicRuntimeContracts = {
  ScopeCreateInput,
  ScopeOutput,
  ScopeListOutput,
  StateOutput,
  ScopeActivationOutput,
  RuntimeTurnInput,
  RuntimeTurnOutput,
  WorkingMemoryOutput,
  StableStateOutput,
  FastLayerViewOutput,
  LayerStatusOutput,
  HealthOutput
} as const;

export const DebugSurfaceContracts = {
  RetrieveInput,
  RetrieveOutput,
  AnswerInput,
  AnswerOutput,
  MemoryEventListOutput,
  DigestListOutput,
  DigestStateOutput,
  DigestStateHistoryOutput,
  ReminderCreateInput,
  ReminderOutput,
  ReminderListOutput,
  ReminderCancelOutput
} as const;

export const InternalControlContracts = {
  MemoryEventInput,
  MemoryEventOutput,
  DigestRequestInput,
  DigestEnqueueOutput,
  DigestRebuildInput,
  DigestRebuildOutput
} as const;

export const PublicRuntimeRoutes = {
  health: "/health",
  createScope: "/scopes",
  listScopes: "/scopes",
  setActiveScope: "/scopes/:id/active",
  getActiveState: "/state",
  runtimeTurn: "/memory/runtime/turn",
  workingState: "/memory/working-state",
  stableState: "/memory/stable-state",
  fastView: "/memory/fast-view",
  layerStatus: "/memory/layer-status"
} as const;

export const DebugSurfaceRoutes = {
  retrieve: "/memory/retrieve",
  answer: "/memory/answer",
  listEvents: "/memory/events",
  listDigests: "/memory/digests",
  getDigestState: "/memory/state",
  getDigestStateHistory: "/memory/state/history",
  createReminder: "/reminders",
  listReminders: "/reminders",
  cancelReminder: "/reminders/:id/cancel"
} as const;

export const InternalControlRoutes = {
  ingestEvent: "/memory/events",
  enqueueDigest: "/memory/digest",
  rebuildDigest: "/memory/digest/rebuild"
} as const;

// The frozen public /v1 API surface — the single source of truth for what
// external layers (hosted version, GPT-API layer) may depend on. Guarded by
// apps/api/src/public-v1-contract.snapshot.test.ts. Additive-optional changes
// are allowed; removals/renames/retypes/required-additions are breaking.
export const PublicV1Contracts = {
  "POST /scopes": { request: ScopeCreateInput, response: ScopeOutput },
  "GET /scopes": { response: ScopeListOutput },
  "POST /scopes/:id/active": { response: ScopeActivationOutput },
  "GET /state": { response: StateOutput },
  "POST /memory/events": { request: MemoryEventInput, response: MemoryEventOutput },
  // Narrowed to stable top-level fields: the diagnostic/ranking sub-objects
  // (RetrieveOutput.retrieval, AnswerOutput.evidence, RuntimeTurnOutput
  // layerAlignment/retrievalPlan/version/notes/warnings/evidence) are still
  // returned in the HTTP response but are intentionally NOT part of the frozen
  // /v1 contract, so they can evolve without a breaking change.
  "POST /memory/retrieve": { request: RetrieveInput, response: RetrieveOutput.omit({ retrieval: true }) },
  "POST /memory/answer": { request: AnswerInput, response: AnswerOutput.pick({ answer: true }) },
  "POST /memory/digest": { request: DigestRequestInput, response: DigestEnqueueOutput },
  // What a digest kept and what it threw away. Only the two top-level arrays are
  // frozen; see the note on DigestSelectionOutput for why `drops` items are not.
  "GET /memory/digests/:digestId/selection": { response: DigestSelectionOutput },
  "POST /memory/runtime/turn": { request: RuntimeTurnInput, response: RuntimeTurnOutput.pick({ answer: true, answerMode: true, writeTier: true, digestTriggered: true }) },
  "GET /memory/facts": { query: ScopeIdQuery, response: MemoryFactsOutput },
  // "Why do you believe this, and what did you believe before" is the question
  // this engine exists to answer. Leaving its only external interface outside the
  // promise made the auditability claim unverifiable from the one side that counts.
  "GET /memory/facts/:factId/provenance": { query: ScopeIdQuery, response: FactProvenanceOutput },
  "POST /memory/facts/forget": { request: ForgetFactInput, response: MemoryForgetOutput },
  // The ontology a caller needs to interpret `GET /memory/facts` at all: which
  // facets exist, what they hold, and what may write to them. Held out of the
  // registry at 1.3.0 to keep a young pack model free to move; the console and
  // gateway have since shipped against it, so the shape is load-bearing either
  // way and is better stated than assumed.
  "GET /facet-pack": { query: OptionalScopeIdQuery, response: FacetPackOutput },
  "POST /memory/notes": { request: AddNoteInput, response: AddNoteOutput },
  // Narrowed like RetrieveOutput above: the live response also carries
  // `personaPrompt`, a persona string the scope's domain template supplies. That
  // is a statement about how a client should *speak*, not about what this engine
  // remembers, and freezing it would cement a product concern into a memory
  // contract. It keeps being returned; it is just free to change.
  "GET /memory/relationship-context/:scopeId": { response: RelationshipContextOutput },
  // Erasure is the one operation a caller cannot verify by asking again later —
  // if it silently stops working, the data it was supposed to remove is still
  // there and nobody finds out. It belongs under the guard.
  "DELETE /scopes/:id": { response: ScopeDeleteOutput },
  "POST /reminders": { request: ReminderCreateInput, response: ReminderOutput },
  "GET /reminders": { response: ReminderListOutput },
  "POST /reminders/:id/cancel": { response: ReminderCancelOutput },
  "GET /health": { response: HealthOutput }
} as const;
