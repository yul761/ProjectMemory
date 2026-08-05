/**
 * Why a piece of information did not make it into the digest or the state.
 *
 * Every one of these was previously a silent `continue` or `splice`. An engine
 * that claims auditable memory must be able to say what it dropped and why —
 * losing data is survivable, losing it silently is not.
 */
export type DropReason =
  | "facet_not_registered" // facet outside the active pack
  | "cap_evicted" // facet at capacity, oldest entry retired
  | "cap_rejected_incoming" // facet at capacity and fully write-protected
  | "no_display_group" // facet has no display group mapping
  | "consolidation_skipped"; // facet not eligible for consolidation

export interface DropRecord {
  reason: DropReason;
  detail: Record<string, unknown>;
}

/**
 * Drop details are echoed back through the API, and a dropped value can be an
 * entire session. Cap the stored copy so the log stays a log.
 */
const MAX_VALUE_CHARS = 200;

export function recordDrop(
  log: DropRecord[],
  reason: DropReason,
  detail: Record<string, unknown>
): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    safe[key] =
      typeof value === "string" && value.length > MAX_VALUE_CHARS
        ? value.slice(0, MAX_VALUE_CHARS)
        : value;
  }
  log.push({ reason, detail: safe });
}
