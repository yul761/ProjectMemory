# StateCore Humanization — Wave 1: "AI Knows You"

**Date:** 2026-06-17
**Scope:** Wave 1 of the humanization feature set. Adds the foundational layer that makes the AI feel like it genuinely knows the user — through automatic extraction of personal details, a relationship context builder, and a default persona. Wave 2 (proactive engagement, emotional pattern detection, contradiction detection) builds on this foundation.

---

## Problem Statement

StateCore currently captures decisions, constraints, goals, and todos — the structural facts of a project or life. It does not capture who the user is: their name, their cat's name, their job, their city. This means every conversation starts from scratch in terms of personal context, creating a "chatbot" feeling rather than a "friend who knows you" feeling.

The goal of Wave 1 is to close this gap at the infrastructure level: capture personal details automatically, compute a relationship context on demand, and provide a persona prompt that makes the AI respond like a warm, attentive companion rather than a generic assistant.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Relationship context delivery | New API endpoint `GET /memory/relationship-context/:scopeId` | App controls how context is used; maximum flexibility |
| Personal detail extraction | Automatic via `classify_event` LLM worker | Zero friction for user; details captured as they're mentioned |
| Relationship duration | Computed from first MemoryEvent date, not stored separately | No entity management overhead |
| Persona system | Default persona in `personal` domain config, not user-configurable | YAGNI; get the default right first |
| `emotional_pattern` type | Added to type vocabulary, populated in Wave 2 | Allows classify_event to write patterns now; detection job comes later |

---

## Architecture

```
User conversation
    ↓
POST /memory/events   (existing — ingest what user said)
    ↓ (async, classify_event worker, new behavior)
classify_event → recognises personal_detail type
    → writes to MemoryEvent.classifiedType = "personal_detail"
    → expiresAt = null (permanent)

App starts new conversation
    ↓
GET /memory/relationship-context/:scopeId  (NEW endpoint)
    → reads scope, stableFacts, classified events
    → computes RelationshipContext
    → returns JSON
    ↓
App builds system prompt:
    [persona] + [relationship context block]
    ↓
App calls LLM → AI responds naturally using context
```

---

## Part 1: New Entity Types

### 1.1 `personal_detail` (new, added to `personal` domain config)

```typescript
{
  name: "personal_detail",
  description: "Small personal facts: name, pets, job, city, hobbies, family, routines",
  retention: "permanent",
  driftProtected: true,
  conflictDetectable: false
}
```

**Auto-detection examples (classify_event):**
- "我叫小明" → `personal_detail: "name: 小明"`
- "我有一只猫叫 Luna" → `personal_detail: "has a cat named Luna"`
- "我是前端工程师" → `personal_detail: "job: frontend engineer"`
- "我住在上海" → `personal_detail: "lives in Shanghai"`
- "我妈妈身体不太好" → `personal_detail: "mother's health is a concern"`
- "我不喝咖啡" → `personal_detail: "doesn't drink coffee"`

**Updated classify prompt for `personal`:**

Add to `personal.ts` classificationSystemPrompt:
```
- personal_detail: small personal facts about the user (name, pets, job, location, family, hobbies, preferences, routines)
  Examples: "my dog's name is Max", "I'm a teacher", "I live in Beijing", "I don't eat meat"
  These are facts ABOUT THE PERSON, not decisions or goals.
  Retain permanently — these rarely change and make conversations feel personal.
```

### 1.2 `emotional_pattern` (new, placeholder for Wave 2)

```typescript
{
  name: "emotional_pattern",
  description: "Recurring emotional or situational patterns (anxious before deadlines, energized by exercise)",
  retention: "long-term",
  driftProtected: false,
  conflictDetectable: false,
  autoExpireAfterDays: 90
}
```

Wave 2's weekly detection job will write to this type. Wave 1 only registers it in the vocabulary so the classify_event LLM can write obvious patterns it notices directly.

### 1.3 Relationship Duration (computed, not stored)

`durationDays` is computed at request time:
```typescript
const firstEvent = await prisma.memoryEvent.findFirst({
  where: { scopeId },
  orderBy: { createdAt: "asc" }
});
const durationDays = firstEvent
  ? Math.floor((Date.now() - firstEvent.createdAt.getTime()) / 86_400_000)
  : 0;
```

No entity type or schema change required.

---

## Part 2: Relationship Context Builder

### 2.1 New File: `packages/core/src/relationship-context.ts`

```typescript
export interface RelationshipContext {
  durationDays: number;
  personalDetails: string[];      // all personal_detail classified events content
  activeGoals: string[];          // stableFacts.goals (if personal template)
  currentFeeling: string | null;  // most recent "feeling" event within 7 days
  pendingFollowUps: string[];     // commitments/experiences >7 days old, no follow-up (max 3)
  personaPrompt: string | null;   // from domain config's defaultPersonaPrompt
}

export async function buildRelationshipContext(
  scopeId: string,
  db: typeof prisma
): Promise<RelationshipContext>
```

**`pendingFollowUps` logic:**

A MemoryEvent qualifies as a pending follow-up if:
1. Its `classifiedType` is `"commitment"` or `"experience"`
2. `createdAt` is more than 7 days ago
3. No subsequent event in the same scope references the same content (Jaccard similarity ≥ 0.5 with any event created after it)

Return maximum 3 pending follow-ups, ordered by age (oldest first).

**`currentFeeling` logic:**

Most recent event where `classifiedType = "feeling"` and `createdAt > now - 7 days`. Returns event content string. Returns null if no recent feeling.

**`personalDetails` logic:**

All events where `classifiedType = "personal_detail"` and `expiresAt IS NULL`. Return `content` array.

### 2.2 New API Endpoint

**`GET /memory/relationship-context/:scopeId`**

Location: `apps/api/src/memory.controller.ts` (new route)

```typescript
@Get("/memory/relationship-context/:scopeId")
async getRelationshipContext(
  @Param("scopeId") scopeId: string,
  @Req() req: RequestWithUser
) {
  const scope = await this.domain.projectService.getScope(req.userId, scopeId);
  if (!scope) throw new NotFoundException("Scope not found");
  return buildRelationshipContext(scopeId, prisma);
}
```

**Example response:**
```json
{
  "durationDays": 45,
  "personalDetails": [
    "name: 小明",
    "has a cat named Luna",
    "job: frontend engineer"
  ],
  "activeGoals": [
    "lose 10kg before summer",
    "learn piano"
  ],
  "currentFeeling": "anxious about the presentation",
  "pendingFollowUps": [
    "mentioned job interview 8 days ago — no update",
    "said they would call their mom this weekend (12 days ago)"
  ],
  "personaPrompt": "You are a warm, attentive personal AI companion..."
}
```

**When `personaPrompt` is null:** scope uses `project` or another domain that has no `defaultPersonaPrompt`. The app should use its own default system prompt.

### 2.3 Recommended App Integration Pattern

The endpoint is intentionally low-level. The consuming app builds the final system prompt:

```typescript
const ctx = await fetch(`/memory/relationship-context/${scopeId}`).then(r => r.json());

const systemPrompt = [
  ctx.personaPrompt ?? "You are a helpful assistant.",
  "",
  ctx.durationDays > 0
    ? `You have known this person for ${ctx.durationDays} days.`
    : "",
  ctx.personalDetails.length
    ? `Personal details:\n${ctx.personalDetails.map(d => `- ${d}`).join('\n')}`
    : "",
  ctx.activeGoals.length
    ? `Their current goals:\n${ctx.activeGoals.map(g => `- ${g}`).join('\n')}`
    : "",
  ctx.currentFeeling
    ? `They recently mentioned feeling: ${ctx.currentFeeling}`
    : "",
  ctx.pendingFollowUps.length
    ? `Worth checking in on (naturally, not every message):\n${ctx.pendingFollowUps.map(f => `- ${f}`).join('\n')}`
    : ""
].filter(Boolean).join('\n');
```

---

## Part 3: Default Persona System

### 3.1 New Field in DomainConfig

Add optional `defaultPersonaPrompt?: string` to `DomainConfig` interface in `packages/core/src/domain-configs/types.ts`:

```typescript
export interface DomainConfig {
  // ... existing fields ...
  defaultPersonaPrompt?: string;  // injected when building relationship context
}
```

### 3.2 Personal Domain Persona

Add to `packages/core/src/domain-configs/personal.ts`:

```typescript
defaultPersonaPrompt: `You are a warm, attentive personal AI companion.
You remember the small things that matter to this person.
You respond like a thoughtful friend: genuine, occasionally curious, never preachy.
You naturally reference what you know about them — their name, their cat, their goals — without it feeling like a database lookup.
When someone's mood seems different from usual, you notice.
You check in on things that mattered — not every message, but when it feels right.
Keep responses concise unless the person clearly wants to talk.`
```

### 3.3 Health Domain Persona

Add to `packages/core/src/domain-configs/health.ts`:

```typescript
defaultPersonaPrompt: `You are a supportive health and fitness companion.
You know this person's physical limitations and always respect them.
You're encouraging but realistic — you don't sugarcoat progress but you genuinely celebrate it.
You remember their specific goals and constraints and factor them into every suggestion.`
```

`project.ts` and `learning.ts` get no `defaultPersonaPrompt` (professional/informational contexts).

### 3.4 buildRelationshipContext uses persona

In `buildRelationshipContext`:
```typescript
const config = getDomainConfig(scope.template);
const personaPrompt = config.defaultPersonaPrompt ?? null;
```

---

## File Map

| File | Action |
|------|--------|
| `packages/core/src/domain-configs/types.ts` | Modify — add `defaultPersonaPrompt?: string` |
| `packages/core/src/domain-configs/personal.ts` | Modify — add `personal_detail`, `emotional_pattern` entity types + updated classify prompt + persona |
| `packages/core/src/domain-configs/health.ts` | Modify — add health persona |
| `packages/core/src/relationship-context.ts` | Create — `RelationshipContext` type + `buildRelationshipContext()` |
| `packages/core/src/index.ts` | Modify — export `RelationshipContext`, `buildRelationshipContext` |
| `apps/api/src/memory.controller.ts` | Modify — add `GET /memory/relationship-context/:scopeId` |

No schema changes required — reads from existing `MemoryEvent.classifiedType` and `MemoryEvent.content` fields added in the domain config task.

---

## Success Criteria

1. After ingesting "我叫小明，我有一只猫叫 Luna，我是前端工程师" — `GET /memory/relationship-context/:scopeId` returns `personalDetails: ["name: 小明", "has a cat named Luna", "job: frontend engineer"]`
2. `durationDays` correctly reflects days since first event
3. A `commitment` event older than 7 days with no follow-up appears in `pendingFollowUps`
4. `currentFeeling` is null if no feeling event in last 7 days; otherwise returns most recent
5. `personal` scope returns non-null `personaPrompt`; `project` scope returns null `personaPrompt`
6. All existing 164 core tests pass; 3 new tests for `buildRelationshipContext`

---

## Out of Scope (Wave 2)

- `detect_emotional_pattern` weekly worker job
- Enhanced daily_remind with proactive follow-up tone
- Contradiction detection endpoint
- User-customizable persona
- `relationship_milestone` events (beyond computed duration)
