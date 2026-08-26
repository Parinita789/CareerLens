/**
 * Caps how many async operations run at once.
 *
 * Used to keep global limits global once work runs concurrently — e.g. four
 * job sources scraping in parallel must still share one LLM concurrency budget
 * rather than each opening their own.
 */
export class Limiter {
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`Limiter max must be >= 1, got ${max}`);
  }

  /** Number of operations currently holding a slot. Exposed for tests. */
  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Loop rather than a single await. A waiter woken by a release can find the
    // slot already taken by a caller that arrived while it was being resumed —
    // resuming a promise takes a microtask turn, and a fresh caller reaching the
    // synchronous check in that window claims the slot first. Re-checking is
    // what keeps `active` from exceeding `max`.
    while (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
