// A TTL cache with a hard entry cap. On every write it opportunistically purges
// expired entries and evicts the least-recently-written entry once the cap is
// exceeded, so memory stays bounded without a background timer (no import-time
// side effects in this library).
export class BoundedTtlCache<V> {
  private readonly map = new Map<string, { expiresAt: number; value: V }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, now: number = Date.now()): void {
    // Opportunistically purge expired entries.
    for (const [k, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(k);
    }
    // delete-then-set so insertion order tracks write recency (Map keeps order).
    this.map.delete(key);
    this.map.set(key, { expiresAt: now + this.ttlMs, value });
    // Evict least-recently-written entries beyond the cap.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
