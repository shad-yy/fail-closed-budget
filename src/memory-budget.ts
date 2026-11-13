/**
 * A ceiling on how many calls this process makes to each upstream API, per window.
 *
 * It counts in process memory on purpose. A shared store such as Redis usually
 * backs the cache as well, so when the store is down every request is a cache
 * miss and becomes an upstream call. A ceiling that lived in that store would
 * disappear in exactly the situation it exists for.
 *
 * It fails closed: once the window's allowance is spent, calls are refused
 * until the window ends. It does not queue, retry or wait.
 *
 * It is per process. Ten instances mean ten ceilings, so this is not a promise
 * about an account's total usage. It is the part one process can enforce on
 * its own.
 */

export interface Budget {
  /** Calls allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface MemoryBudget<P extends string> {
  /** Take one call from a provider's allowance. False means: do not make the call. */
  spend(provider: P): boolean;
  /** Calls left in the current window, or null for a provider with no budget. */
  remaining(provider: P): number | null;
  /** Forget all counts. */
  reset(): void;
}

export interface MemoryBudgetOptions {
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export function createMemoryBudget<P extends string>(
  budgets: Readonly<Record<P, Budget>>,
  options: MemoryBudgetOptions = {},
): MemoryBudget<P> {
  for (const [name, b] of Object.entries(budgets) as [string, Budget][]) {
    if (!Number.isInteger(b.limit) || b.limit < 1) {
      throw new RangeError(`budget "${name}": limit must be a whole number of at least 1`);
    }
    if (!(b.windowMs > 0)) {
      throw new RangeError(`budget "${name}": windowMs must be greater than 0`);
    }
  }

  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; windowStart: number }>();

  /** The provider's bucket if its window is still open, otherwise undefined. */
  const openBucket = (provider: P, budget: Budget, at: number) => {
    const bucket = buckets.get(provider);
    return bucket && at - bucket.windowStart < budget.windowMs ? bucket : undefined;
  };

  return {
    spend(provider) {
      const budget = budgets[provider] as Budget | undefined;
      // A provider nobody configured is not blocked: a typo in a key should show
      // up as "unbounded", not as a client that silently can't make any call.
      if (!budget) return true;
      const at = now();
      const bucket = openBucket(provider, budget, at);
      if (!bucket) {
        buckets.set(provider, { count: 1, windowStart: at });
        return true;
      }
      if (bucket.count >= budget.limit) return false;
      bucket.count += 1;
      return true;
    },

    remaining(provider) {
      const budget = budgets[provider] as Budget | undefined;
      if (!budget) return null;
      return budget.limit - (openBucket(provider, budget, now())?.count ?? 0);
    },

    reset() {
      buckets.clear();
    },
  };
}
