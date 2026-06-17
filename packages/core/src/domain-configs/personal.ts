import type { DomainConfig } from "./types";

export const personalConfig: DomainConfig = {
  name: "personal",
  description: "Personal life assistant — goals, commitments, experiences, and daily reflections",
  entityTypes: [
    { name: "life_decision", description: "A significant life decision such as changing jobs, moving, or adopting a new habit", retention: "permanent",  driftProtected: true,  conflictDetectable: true,  },
    { name: "goal",          description: "A personal goal the user wants to achieve",                                         retention: "long-term", driftProtected: true,  conflictDetectable: true  },
    { name: "commitment",    description: "A promise made to self or others",                                                   retention: "long-term", driftProtected: false, conflictDetectable: false },
    { name: "person_note",   description: "Important information about a specific person in the user's life",                  retention: "long-term", driftProtected: false, conflictDetectable: false },
    { name: "experience",    description: "A noteworthy experience or event",                                                   retention: "medium",    driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 60 },
    { name: "feeling",       description: "A current emotional state or mood",                                                  retention: "short",     driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 7  },
    { name: "personal_detail",
      description: "Small personal facts: name, pets, job, location, hobbies, family, daily routines, preferences",
      retention: "permanent",
      driftProtected: true,
      conflictDetectable: false },
    { name: "emotional_pattern",
      description: "Recurring emotional or situational patterns (anxious before deadlines, energized by exercise)",
      retention: "long-term",
      driftProtected: false,
      conflictDetectable: false,
      autoExpireAfterDays: 90 },
    { name: "noise",         description: "Casual chatter with no lasting value",                                               retention: "discard",   driftProtected: false, conflictDetectable: false }
  ],
  classificationSystemPrompt: `You are a personal life memory classifier. Decide what in this input is worth remembering long-term.

Categories:
- personal_detail: small facts ABOUT THE PERSON themselves (name, pets, job, city, hobbies, family, dietary preferences, daily routines)
  Examples: "my dog's name is Max", "I'm a teacher", "I live in Beijing", "I don't eat meat", "I hate Mondays"
  These are permanent identity facts, not decisions or goals.
- life_decision: major life direction change ("I decided to move to Vancouver", "I'm quitting sugar for good")
- goal: personal goal ("I want to lose 10kg this year", "I want to learn piano")
- commitment: promise to self or others ("I promised mom I'd call every week")
- person_note: important info about someone ELSE ("Sarah is looking for a new job")
- experience: memorable event ("Had an amazing dinner at X restaurant")
- feeling: current mood (expires in 7 days) ("I'm feeling anxious today")
- emotional_pattern: recurring pattern across many interactions ("I always feel stressed on Sundays")
- noise: casual chatter, nothing worth keeping ("ok", "sure", weather comments)

In Chinese: "我叫..." → personal_detail. "我有..." (pet/possession) → personal_detail. "我是..." (job/identity) → personal_detail.
"我决定..."/"我要..." → life_decision or goal. "答应了..." → commitment.
Be conservative: when unsure between personal_detail and noise, prefer personal_detail for genuine self-descriptions.

Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Focus on the user's long-term goals, major decisions, active commitments, and relationship notes",
  dailyReminderPrompt: `Generate 1-2 short messages that sound like a thoughtful friend checking in.

Priority order:
1. Pending follow-ups — things mentioned but never updated (e.g. "how did that interview go?")
2. Goal progress check-ins — if a goal was set long ago with no recent update
3. A gentle nudge about a commitment or pattern if relevant

Rules:
- Use the person's name or personal details naturally if known and relevant
- Tone: casual, warm, genuinely curious — NOT a task manager
- GOOD: "Hey, how did that interview go last week?"
- BAD: "Reminder: Your commitment 'interview' has been pending 8 days."
- Never reference internal data structures, dates, or IDs
- If nothing compelling to follow up on, return an empty array rather than a generic reminder

Return JSON: { "reminders": string[] }`,
  conflictPatterns: ["我改变主意了", "我不再", "我放弃了", "我决定不"],
  defaultPersonaPrompt: `You are a warm, attentive personal AI companion.
You remember the small things that matter to this person.
You respond like a thoughtful friend: genuine, occasionally curious, never preachy.
You naturally reference what you know about them — their name, their cat, their goals — without it feeling like a database lookup.
When someone's mood seems different from usual, you notice it gently.
You check in on things that mattered — not every message, but when it feels right.
Keep responses concise unless the person clearly wants to talk.`
};
