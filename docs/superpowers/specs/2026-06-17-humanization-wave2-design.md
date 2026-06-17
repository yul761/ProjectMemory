# StateCore Humanization — Wave 2: Proactive Engagement

**Date:** 2026-06-17
**Scope:** Wave 2 of the humanization feature set. Builds on Wave 1's "AI knows you" foundation to add proactive engagement: friend-like daily reminders with follow-up generation, weekly emotional pattern detection, and a contradiction detection endpoint.

---

## Problem Statement

Wave 1 gave the AI access to personal details and a persona. But knowing someone is not the same as actively caring about them. Wave 2 adds the proactive dimension:

- The AI checks in on things that mattered (not just task reminders)
- The AI notices recurring emotional patterns across weeks of interaction
- The AI can gently surface when a user's current request contradicts their stated goals

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Contradiction response format | `{ hasContradiction, message }` | Simple, App controls presentation |
| Emotional pattern threshold | 3+ occurrences before LLM analysis | Prevents false positives from single events |
| Pattern accumulation | Delete old + write new each week | Prevents stale patterns from accumulating |
| Contradiction detection method | LLM (small prompt) | More accurate than heuristic, cost is low per-call |

---

## Part 1: Enhanced Daily Remind

### What changes

The existing `runDailyRemindJob()` in `apps/worker/src/main.ts` already:
- Reads scopes with `notificationWebhook` set
- Reads `stableFacts` from latest `DigestStateSnapshot`
- Reads recent `commitment` events
- Calls LLM with domain config's `dailyReminderPrompt`
- POSTs result to webhook

**Two changes needed:**

**1. Richer context passed to LLM:**

Current context object:
```typescript
{
  stableFacts: ...,
  commitments: [...contents]
}
```

New context object:
```typescript
{
  stableFacts: ...,
  personalDetails: [...],      // NEW: classifiedType = "personal_detail"
  pendingFollowUps: [...],     // NEW: commitment/experience events > 7 days old, no update
  recentPatterns: [...]        // NEW: classifiedType = "emotional_pattern" events
}
```

Reads `personalDetails` exactly as `buildRelationshipContext` does (same query).
Reads `pendingFollowUps` exactly as `buildRelationshipContext` does (same query).
Reads `recentPatterns` from `memoryEvent.findMany({ where: { scopeId, classifiedType: "emotional_pattern" } })`.

**2. Updated `dailyReminderPrompt` in `personal.ts`:**

```
Generate 1-2 short messages that sound like a thoughtful friend checking in.

Priority order:
1. Pending follow-ups — things mentioned but never updated (e.g., "how did that interview go?")
2. Goal progress check-ins — if a goal was set long ago with no recent progress signal
3. A gentle nudge about a commitment or pattern if relevant

Rules:
- Use the person's name or personal details naturally if known and relevant
- Tone: casual, warm, genuinely curious — NOT a task manager
- GOOD: "Hey, how did that interview go last week?"
- BAD: "Reminder: Your commitment 'interview' has been pending 8 days."
- Never reference internal data structures or dates
- If nothing compelling to follow up on, send only 1 reminder or skip entirely (empty array is fine)

Return JSON: { "reminders": string[] }
```

### Files modified
- `packages/core/src/domain-configs/personal.ts` — update `dailyReminderPrompt`
- `apps/worker/src/main.ts` — expand context object in `runDailyRemindJob()`

---

## Part 2: Emotional Pattern Detection

### New periodic job: `runDetectEmotionalPatternsJob()`

Runs every 7 days via `setInterval`. Processes all scopes with `template = "personal"` (regardless of `notificationWebhook`).

**Algorithm:**

```
for each scope with template = "personal":
  1. Read all feeling events from last 30 days
     (classifiedType = "feeling", createdAt >= now - 30 days)
  
  2. If fewer than 3 feeling events total → skip (not enough data)
  
  3. Group by approximate content (basic token overlap)
     Any emotion appearing in 3+ events → candidate for pattern analysis
  
  4. If any candidates found:
     a. Delete existing emotional_pattern events for this scope
        (prevents stale patterns accumulating)
     b. Call LLM with all feeling events + timestamps
     c. LLM returns: { "patterns": string[] }
     d. For each pattern string:
        → Create new MemoryEvent(
             scopeId, type: "stream", source: "api",
             content: pattern,
             classifiedType: "emotional_pattern",
             classifiedImportance: 0.7
           )
```

**LLM prompt:**

```typescript
const systemPrompt = `Analyze these feeling events and identify recurring emotional patterns.
Only report patterns that appear 3 or more times.
Be specific about context: time of week, triggers, or situations if evident.
Keep each pattern to one concise sentence.
Examples: "tends to feel anxious on Sunday evenings", "energized and positive after exercise"
Return JSON: { "patterns": string[] }
If no clear patterns: return { "patterns": [] }`;

const userPrompt = events
  .map(e => `${e.createdAt.toISOString().slice(0,10)}: ${e.content}`)
  .join('\n');
```

**Token grouping (simple, no ML):**

```typescript
function tokenize(s: string) {
  return s.toLowerCase().replace(/[^a-z一-龥]/g, " ").split(/\s+/).filter(t => t.length > 2);
}

function groupSimilarFeelings(events: MemoryEvent[]): MemoryEvent[][] {
  const groups: MemoryEvent[][] = [];
  for (const event of events) {
    const tokens = new Set(tokenize(event.content));
    const match = groups.find(g =>
      g.some(e => tokenize(e.content).filter(t => tokens.has(t)).length >= 2)
    );
    if (match) match.push(event);
    else groups.push([event]);
  }
  return groups.filter(g => g.length >= 3);
}
```

### Files modified
- `apps/worker/src/main.ts` — add `runDetectEmotionalPatternsJob()` and 7-day interval

---

## Part 3: Contradiction Detection Endpoint

### New endpoint: `POST /memory/check-contradiction`

**Request:**
```json
{ "scopeId": "uuid", "content": "帮我找一个好吃的甜品店" }
```

**Response (no contradiction):**
```json
{ "hasContradiction": false, "message": null }
```

**Response (contradiction found):**
```json
{ "hasContradiction": true, "message": "你之前说想减少糖分摄入" }
```

**Logic:**

```typescript
async function checkContradiction(scopeId: string, content: string, llm): Promise<{ hasContradiction: boolean; message: string | null }> {
  // 1. Get stableFacts
  const snapshot = await prisma.digestStateSnapshot.findFirst({
    where: { scopeId }, orderBy: { createdAt: "desc" }
  });
  const stableFacts = (snapshot?.state as any)?.stableFacts;
  if (!stableFacts) return { hasContradiction: false, message: null };
  
  const facts = [
    stableFacts.goal,
    ...(stableFacts.decisions ?? []),
    ...(stableFacts.constraints ?? [])
  ].filter(Boolean).slice(0, 10); // max 10 facts to keep prompt short
  
  if (!facts.length) return { hasContradiction: false, message: null };
  
  // 2. LLM contradiction check
  const systemPrompt = `You check if a user's request conflicts with their established goals and decisions.
If there is a clear conflict, return a short, natural, non-judgmental sentence mentioning the relevant fact (in the same language as the user's input).
If no conflict or uncertain, return no contradiction.
Return JSON: { "hasContradiction": boolean, "message": string | null }`;

  const userPrompt = `Established facts:\n${facts.map(f => `- ${f}`).join('\n')}\n\nUser input: ${content}`;
  
  try {
    const raw = await llm.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);
    const parsed = JSON.parse(raw) as { hasContradiction?: boolean; message?: string | null };
    return {
      hasContradiction: parsed.hasContradiction === true,
      message: parsed.hasContradiction ? (parsed.message ?? null) : null
    };
  } catch {
    return { hasContradiction: false, message: null }; // fail safe: never block user
  }
}
```

**Controller:**

```typescript
@Post("/memory/check-contradiction")
async checkContradiction(@Req() req: RequestWithUser, @Body() body: unknown) {
  const input = z.object({
    scopeId: z.string().uuid(),
    content: z.string().min(1).max(500)
  }).parse(body);
  
  const scope = await this.domain.projectService.getScope(req.userId, input.scopeId);
  if (!scope) throw new NotFoundException("Scope not found");
  
  if (!this.domain.llm) {
    return { hasContradiction: false, message: null }; // LLM required
  }
  
  return checkContradiction(input.scopeId, input.content, this.domain.llm);
}
```

**Key property:** Always returns a valid response even on LLM failure. Never blocks the user.

### Files modified
- `apps/api/src/memory.controller.ts` — add `POST /memory/check-contradiction`

---

## File Map

| File | Action |
|------|--------|
| `packages/core/src/domain-configs/personal.ts` | Modify — update `dailyReminderPrompt` |
| `apps/worker/src/main.ts` | Modify — expand `runDailyRemindJob` context + add `runDetectEmotionalPatternsJob` + 7-day interval |
| `apps/api/src/memory.controller.ts` | Modify — add `POST /memory/check-contradiction` |

No new files. No schema changes. No migrations.

---

## Success Criteria

1. `daily_remind` webhook payload now includes reminders that ask about specific past events (not just "reminder: your goal is X")
2. After 3+ feeling events of similar content, `detect_emotional_patterns` writes an `emotional_pattern` event within the 7-day cycle
3. `POST /memory/check-contradiction { scopeId, content: "帮我找甜品店" }` returns `{ hasContradiction: true, message: "你之前说想减少糖分摄入" }` when the scope has a relevant goal
4. `POST /memory/check-contradiction` returns `{ hasContradiction: false, message: null }` when LLM is unavailable or no conflict found
5. All existing 168 core tests + 14 API unit tests still pass

---

## Out of Scope (possible Wave 3)

- User-customizable reminder frequency
- Contradiction detection with confidence score
- Proactive message push outside daily_remind (real-time contradiction alert)
- Relationship milestone detection and celebration
