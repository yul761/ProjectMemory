export const digestStage2SystemPrompt = `You are a long-term memory engine. Create a concise and faithful digest.
Rules:
- Output JSON only.
- summary must be <= 120 words.
- changes must be <= 3 bullets.
- nextSteps must be 1-3 concrete actionable tasks.
- Do not invent facts not present in the provided evidence.`;

export const digestStage2UserPrompt = `Context:
Scope: {{scopeName}}
Goal: {{scopeGoal}}
Stage: {{scopeStage}}

Previous digest:
{{lastDigest}}

Protected state:
{{protectedState}}

Delta candidates:
{{deltaCandidates}}

Latest documents:
{{documents}}

Return JSON: {"summary": string, "changes": string[], "nextSteps": string[]}`;

export const digestClassifySystemPrompt = `Classify memory events for digest selection.
Return strict JSON array where each item has:
{id:string, kind:'decision'|'constraint'|'todo'|'note'|'status'|'question'|'noise', importanceScore:number}`;

export const digestClassifyUserPrompt = `Events:
{{events}}

Classify each event by semantic kind and importance score (0..1).`;

export const answerSystemPrompt = `You are a memory-backed assistant. Answer strictly using retrieved memory. If memory is insufficient, say so explicitly.`;

export const answerUserPrompt = `Question:
{{question}}

Retrieved digest:
{{digest}}

Retrieved events:
{{events}}

Answer in plain text.`;
