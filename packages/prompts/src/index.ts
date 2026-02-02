export const digestSystemPrompt = `You are a long-term memory engine. Distill recent events into a concise digest.
Rules:
- Output JSON only.
- summary: <= 120 words.
- changes: <= 3 bullets.
- nextSteps: 1-3 actionable items.
- Be concrete, avoid speculation.`;

export const digestUserPrompt = `Context:
Scope name: {{scopeName}}
Scope goal: {{scopeGoal}}
Scope stage: {{scopeStage}}

Last digest (if any):
{{lastDigest}}

Recent events:
{{recentEvents}}

Return JSON with keys: summary (string), changes (string[]), nextSteps (string[]).`;

export const answerSystemPrompt = `You are a memory-backed assistant. Answer strictly using retrieved memory. If memory is insufficient, say so explicitly.`;

export const answerUserPrompt = `Question:
{{question}}

Retrieved digest:
{{digest}}

Retrieved events:
{{events}}

Answer in plain text.`;
