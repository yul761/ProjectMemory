// LLM-backed event classification (stage 1) and shared prompt/JSON helpers.
// Split out of digest-control.ts (2026-08-28) — bodies moved verbatim.
import { z } from "zod";
import type { MemoryEvent } from "../index";
import type { DigestControlConfig, MemoryEventKind, SelectedEvent } from "./types";

const classifierSchema = z.array(z.object({
  id: z.string(),
  kind: z.enum(["decision", "constraint", "todo", "note", "status", "question", "noise"]),
  importanceScore: z.number().min(0).max(1)
}));

export function renderTemplate(template: string, data: Record<string, string>) {
  let output = template;
  for (const [key, value] of Object.entries(data)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

export function parseJson<T>(raw: string): T | null {
  const match = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function classifyEventsWithLlm(input: {
  selectedEvents: SelectedEvent[];
  llm: { chat: (messages: { role: "system" | "user"; content: string }[]) => Promise<string> };
  systemPrompt: string;
  userPromptTemplate: string;
}) {
  const eventText = input.selectedEvents
    .map((item) => `${item.event.id}: ${item.event.content}`)
    .join("\n");

  const userPrompt = renderTemplate(input.userPromptTemplate, { events: eventText });
  const raw = await input.llm.chat([
    { role: "system", content: input.systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  const parsed = parseJson<unknown>(raw);
  const validated = classifierSchema.safeParse(parsed);
  if (!validated.success) return;

  const byId = new Map(validated.data.map((item) => [item.id, item]));
  for (const item of input.selectedEvents) {
    const found = byId.get(item.event.id);
    if (!found) continue;
    item.features.kind = found.kind;
    item.features.importanceScore = found.importanceScore;
  }
}
