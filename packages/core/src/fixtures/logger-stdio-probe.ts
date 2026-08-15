// Probe process for logger-stdio.test.ts: imports the real library logger and
// emits one info-level log line, so the parent test can assert which fd it lands on.
import { logger } from "../index";

logger.info("logger-stdio-probe");
