import type { DomainConfig } from "./types";

export const learningConfig: DomainConfig = {
  name: "learning",
  description: "Study assistant — learning goals, knowledge claims, open questions, and progress tracking",
  entityTypes: [
    { name: "knowledge_claim", description: "A statement about what the user already knows or doesn't know", retention: "long-term", driftProtected: true,  conflictDetectable: true  },
    { name: "learning_goal",   description: "A learning objective with optional deadline",                   retention: "long-term", driftProtected: true,  conflictDetectable: false },
    { name: "open_question",   description: "Something the user doesn't yet understand",                     retention: "medium",    driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 30 },
    { name: "insight",         description: "A key understanding or breakthrough moment",                    retention: "medium",    driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 60 },
    { name: "progress",        description: "Today's study progress",                                        retention: "short",     driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 14 },
    { name: "noise",           description: "Filler with no learning value",                                 retention: "discard",   driftProtected: false, conflictDetectable: false }
  ],
  classificationSystemPrompt: `You are a learning memory classifier.

Categories:
- knowledge_claim: what the user knows or doesn't know ("I already know React hooks", "I don't understand Rust lifetimes")
- learning_goal: what they want to learn ("I want to master TypeScript in 3 months")
- open_question: unresolved confusion ("I still don't get async generators")
- insight: a key realisation ("I finally understand why closures capture by reference")
- progress: today's study log ("read chapter 3 today")
- noise: unrelated chatter

knowledge_claim is critical — AI must calibrate explanation depth to user's stated knowledge level.
Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Prioritise knowledge level claims so AI can calibrate depth. Then surface learning goals and open questions."
};
