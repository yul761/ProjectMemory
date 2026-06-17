export type { DomainConfig, EntityTypeConfig } from "./types";
export { projectConfig }  from "./project";
export { personalConfig } from "./personal";
export { healthConfig }   from "./health";
export { learningConfig } from "./learning";

import { projectConfig }  from "./project";
import { personalConfig } from "./personal";
import { healthConfig }   from "./health";
import { learningConfig } from "./learning";
import type { DomainConfig } from "./types";

const CONFIGS: Record<string, DomainConfig> = {
  project:  projectConfig,
  personal: personalConfig,
  health:   healthConfig,
  learning: learningConfig
};

export const KNOWN_TEMPLATES = Object.keys(CONFIGS);

export function getDomainConfig(template: string | null | undefined): DomainConfig {
  return CONFIGS[template ?? "project"] ?? CONFIGS["project"];
}
