export interface EntityTypeConfig {
  name: string;
  description: string;
  retention: "permanent" | "long-term" | "medium" | "short" | "discard";
  driftProtected: boolean;
  conflictDetectable: boolean;
  autoExpireAfterDays?: number;
}

export interface DomainConfig {
  name: string;
  description: string;
  entityTypes: EntityTypeConfig[];
  classificationSystemPrompt: string;
  digestFocusHint: string;
  dailyReminderPrompt?: string;
  conflictPatterns?: string[];
  defaultPersonaPrompt?: string;
}
