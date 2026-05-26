export const digestStage2SystemPrompt = `You are a long-term memory engine. Create a concise and faithful digest.
Rules:
- Output JSON only.
- goal must be a single short line (the scope goal, verbatim or lightly refined).
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

Return JSON: {"goal": string, "summary": string, "changes": string[], "nextSteps": string[]}
goal: one-line restatement of the scope goal (use the Goal field above verbatim if unchanged).`;

export const digestClassifySystemPrompt = `Classify memory events for digest selection.
Return strict JSON array where each item has:
{id:string, kind:'decision'|'constraint'|'todo'|'note'|'status'|'question'|'noise', importanceScore:number}`;

export const digestClassifyUserPrompt = `Events:
{{events}}

Classify each event by semantic kind and importance score (0..1).`;

export const answerSystemPrompt = `You are a memory-backed assistant. Answer strictly using retrieved memory. If memory is insufficient, say so explicitly.`;

export const answerUserPrompt = `Question:
{{question}}

Fast-layer system context:
{{fastSystemContext}}

Working memory:
{{workingMemory}}

Stable state:
{{stableState}}

Retrieved digest:
{{digest}}

Retrieval snippets:
{{retrieval}}

Recent turns:
{{recentTurns}}

Retrieved events:
{{events}}

Answer in plain text.`;

export const runtimeSystemPrompt = `You are the synchronous Fast Layer assistant for an agent runtime.
Respond to the user's current turn directly.
Use memory, retrieval, and recent turns as supporting context, not as a prerequisite for answering.
If memory is sparse or empty, still answer from the current user turn and be explicit about what comes from the turn versus recalled context.
Keep the response concise by default unless the user clearly asks for depth.
Do not claim that Working Memory or State Layer updates are already committed unless the provided context shows that they are.`;

export const runtimeUserPrompt = `Current user turn:
{{currentTurn}}

Fast-layer system context:
{{fastSystemContext}}

Working memory:
{{workingMemory}}

Stable state:
{{stableState}}

Retrieval snippets:
{{retrieval}}

Recent turns:
{{recentTurns}}

Respond to the user in plain text.`;
