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
    { name: "noise",         description: "Casual chatter with no lasting value",                                               retention: "discard",   driftProtected: false, conflictDetectable: false }
  ],
  classificationSystemPrompt: `You are a personal life memory classifier. Decide what in this input is worth remembering long-term.

Categories:
- life_decision: major life direction change ("I decided to move to Vancouver", "I'm quitting sugar for good")
- goal: personal goal ("I want to lose 10kg this year", "I want to learn piano")
- commitment: promise to self or others ("I promised mom I'd call every week")
- person_note: important info about someone ("Sarah is looking for a new job")
- experience: memorable event ("Had an amazing dinner at X restaurant")
- feeling: current mood (expires in 7 days) ("I'm feeling anxious today")
- noise: casual chatter, nothing worth keeping ("ok", "sure", weather comments)

In Chinese: "我决定..."/"我要..."/"以后我会..." → life_decision or goal. "答应了..." → commitment.
Be conservative: when unsure, classify as noise rather than over-storing.

Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Focus on the user's long-term goals, major decisions, active commitments, and relationship notes",
  dailyReminderPrompt: `Based on the user's memory, generate 1-2 natural, friendly reminders.
Focus on: overdue commitments, goal progress check-ins, decisions worth reflecting on.
Do NOT remind about feelings or experiences — only durable facts.
Be warm, not judgmental. Keep each reminder under 30 words.
Return JSON: { "reminders": string[] }`,
  conflictPatterns: ["我改变主意了", "我不再", "我放弃了", "我决定不"]
};
