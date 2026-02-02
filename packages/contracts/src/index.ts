import { z } from "zod";

export const ProjectStage = z.enum(["idea", "build", "test", "launch"]);
export type ProjectStage = z.infer<typeof ProjectStage>;

export const MemoryType = z.enum(["stream", "document"]);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemorySource = z.enum(["telegram", "cli", "api", "sdk"]);
export type MemorySource = z.infer<typeof MemorySource>;

export const ReminderStatus = z.enum(["scheduled", "sent", "cancelled"]);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const ScopeCreateInput = z.object({
  name: z.string().min(1),
  goal: z.string().min(1).optional(),
  stage: ProjectStage.optional()
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

export const MemoryEventInput = z.object({
  scopeId: z.string().uuid(),
  type: MemoryType,
  source: MemorySource.optional(),
  key: z.string().min(1).optional(),
  content: z.string().min(1)
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
  updatedAt: z.string().nullable()
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
  createdAt: z.string()
});

export const DigestListOutput = z.object({
  items: z.array(DigestOutput),
  nextCursor: z.string().nullable()
});

export const DigestEnqueueOutput = z.object({
  jobId: z.string()
});

export const RetrieveInput = z.object({
  scopeId: z.string().uuid(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional()
});

export const RetrieveOutput = z.object({
  digest: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.string().uuid(),
      content: z.string(),
      createdAt: z.string()
    })
  )
});

export const AnswerInput = z.object({
  scopeId: z.string().uuid(),
  question: z.string().min(1)
});

export const AnswerOutput = z.object({
  answer: z.string()
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
  status: z.literal("ok")
});
export const HealthOutput = z.object({
  status: z.literal("ok")
});
