// Copied from apps/worker/src/digest-lookback.ts; keep in sync.

/**
 * Which events a digest run considers.
 *
 * `createdAt` carries two meanings that had been conflated. Ingest sets it to
 * `occurredAt` when the caller supplies one, so it answers "when did this
 * happen" — which is what retrieval and temporal reasoning want. The digest's
 * lookback window, however, needs "when did we learn this", and filtering the
 * second question with the first has a specific and silent failure:
 *
 *   import two years of conversation with occurredAt set
 *     -> every event's createdAt lands outside a 14-day window
 *     -> the digest selects nothing, reports success, writes no facts
 *
 * That is exactly what `occurredAt` exists for, and the field is part of the
 * frozen /v1 contract, so the combination has to work.
 *
 * `ingestedAt` is stamped on write and never moved. The window now admits an
 * event that is recent by either clock: recently ingested, or recently occurred.
 */
export interface DigestWindowInput {
  scopeId: string;
  lookbackDays: number;
  now?: Date;
}

export function selectDigestEventWindow(input: DigestWindowInput): {
  scopeId: string;
  suppressedAt: null;
  OR?: Array<{ createdAt: { gte: Date } } | { ingestedAt: { gte: Date } }>;
} {
  const base = { scopeId: input.scopeId, suppressedAt: null as null };

  // A lookback of zero or less is a misconfiguration, not an instruction to
  // digest nothing. Leaving the window off is the safe reading — the event-count
  // and character budgets still bound the work.
  if (!Number.isFinite(input.lookbackDays) || input.lookbackDays <= 0) {
    return base;
  }

  const cutoff = new Date((input.now ?? new Date()).getTime() - input.lookbackDays * 86_400_000);
  return {
    ...base,
    OR: [{ createdAt: { gte: cutoff } }, { ingestedAt: { gte: cutoff } }],
  };
}
