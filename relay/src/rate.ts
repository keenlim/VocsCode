/** Fixed-window rate limiter for the relay's public endpoints (docs/REMOTE-ACCESS.md §7).
 *  In-memory on purpose: it is defense in depth in front of Durable Object storage, so losing
 *  the counters when a Hub hibernates costs nothing, and it never turns a request into a write. */
export interface RateLimiter {
  /** True when a call is allowed; false once the window's budget is spent. */
  hit(key: string, limit: number, windowMs: number): boolean;
}

export class FixedWindowLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked keys, so hostile traffic cannot grow the map without bound. */
    private readonly maxKeys = 10_000
  ) {}

  hit(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const window = this.windows.get(key);
    if (!window || t >= window.resetAt) {
      if (this.windows.size >= this.maxKeys) this.prune(t);
      this.windows.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    if (window.count >= limit) return false;
    window.count++;
    return true;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (now >= window.resetAt) this.windows.delete(key);
    if (this.windows.size < this.maxKeys) return;
    // Every window is still live: drop the ones expiring soonest and keep going.
    const oldest = [...this.windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of oldest.slice(0, Math.floor(this.maxKeys / 2))) this.windows.delete(key);
  }
}
