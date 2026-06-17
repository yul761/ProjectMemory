import type { DomainConfig } from "./types";

export const healthConfig: DomainConfig = {
  name: "health",
  description: "Fitness and health assistant — training goals, physical limitations, dietary rules, daily logs",
  entityTypes: [
    { name: "medical_fact",  description: "A permanent medical fact such as allergy, injury history, or chronic condition", retention: "permanent",  driftProtected: true,  conflictDetectable: false },
    { name: "fitness_goal",  description: "A fitness or health goal",                                                       retention: "long-term", driftProtected: true,  conflictDetectable: true  },
    { name: "dietary_rule",  description: "A dietary restriction or rule the user follows",                                 retention: "long-term", driftProtected: true,  conflictDetectable: true  },
    { name: "preference",    description: "A training preference such as time of day or exercise type",                     retention: "long-term", driftProtected: false, conflictDetectable: false },
    { name: "current_plan",  description: "The user's current training or diet plan",                                       retention: "medium",    driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 45 },
    { name: "daily_log",     description: "Today's workout or food log entry",                                              retention: "short",     driftProtected: false, conflictDetectable: false, autoExpireAfterDays: 30 },
    { name: "noise",         description: "Chatter unrelated to health",                                                    retention: "discard",   driftProtected: false, conflictDetectable: false }
  ],
  classificationSystemPrompt: `You are a health and fitness memory classifier.

Categories:
- medical_fact: permanent medical info (allergy, injury, surgery, chronic condition) — ALWAYS protect
- fitness_goal: fitness target ("I want to run 5k by June")
- dietary_rule: food restriction or rule ("I'm lactose intolerant", "no sugar")
- preference: training preference ("I prefer morning runs", "I hate gyms")
- current_plan: current routine ("I'm doing push/pull/legs this month")
- daily_log: today's activity ("ran 3km today", "had a salad for lunch")
- noise: unrelated chatter

IMPORTANT: medical_fact is the highest priority — never mark medical info as noise.
Return JSON: { "entityType": string, "importance": number }`,
  digestFocusHint: "Always surface medical facts and physical limitations first. Then fitness goals and dietary rules.",
  dailyReminderPrompt: `Based on the user's health data, generate 1-2 motivating reminders.
Focus on: goal progress, streak maintenance, upcoming milestones.
Keep it positive and encouraging. Under 30 words each.
Return JSON: { "reminders": string[] }`,
  defaultPersonaPrompt: `You are a supportive health and fitness companion.
You know this person's physical limitations and always respect them — never suggest exercises that could aggravate known injuries.
You are encouraging but realistic: you celebrate genuine progress and gently hold them to their stated goals.
You remember their specific targets and constraints and factor them into every suggestion.`
};
