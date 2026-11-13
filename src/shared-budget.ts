/**
 * A provider's quota tracked in a shared store (Redis or similar), so every
 * instance draws on the same allowance.
 *
 * This layer fails OPEN: if the store errors, the call is allowed. A store
 * outage must not stop the site reading its own data sources. That is exactly
 * why the in-memory ceiling (memory-budget.ts) exists alongside it and fails
 * closed: when this layer goes blind, that one still holds.
 *
 * A limit of null means the provider publishes no limit. Those are never
 * throttled; inventing a number would throttle a source that has none.
 */

/** The three commands this needs. Upstash Redis and ioredis both fit. */
export interface CounterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<number | string | null>;
}

export interface Quota {
  /** Calls per window, or null when the provider publishes no limit. */
  limit: number | null;
  /** Window length in seconds. Windows are aligned to the clock (e.g. each UTC minute). */
  windowSeconds: number;
}

export interface QuotaState {
  /** Whether the call should be made. */
  available: boolean;
  /** Calls left in the window, or null when unknown or unlimited. */
  remaining: number | null;
  /** Seconds until the window resets, when the allowance is spent. */
  resetsIn?: number;
}

export interface SharedBudget<P extends string> {
  /** Record one call and say whether to make it. Call before the request. Never throws. */
  claim(provider: P, scope?: string): Promise<QuotaState>;
  /** Read the state without spending anything, e.g. to order a fallback chain. */
  peek(provider: P, scope?: string): Promise<QuotaState>;
}

export interface SharedBudgetOptions {
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Key prefix in the store. Defaults to "budget". */
  prefix?: string;
}

const UNKNOWN: QuotaState = { available: true, remaining: null };

export function createSharedBudget<P extends string>(
  store: CounterStore | null,
  quotas: Readonly<Record<P, Quota>>,
  options: SharedBudgetOptions = {},
): SharedBudget<P> {
  const now = options.now ?? Date.now;
  const prefix = options.prefix ?? 'budget';

  const keyFor = (provider: P, scope: string | undefined, quota: Quota, at: number) => {
    const bucket = Math.floor(at / 1000 / quota.windowSeconds);
    return `${prefix}:${provider}${scope ? `:${scope}` : ''}:${bucket}`;
  };

  return {
    async claim(provider, scope) {
      const quota = quotas[provider];
      if (quota.limit === null || !store) return UNKNOWN;
      const at = now();
      const key = keyFor(provider, scope, quota, at);
      try {
        const used = await store.incr(key);
        if (used === 1) await store.expire(key, quota.windowSeconds);
        if (used > quota.limit) {
          const elapsed = Math.floor(at / 1000) % quota.windowSeconds;
          return { available: false, remaining: 0, resetsIn: quota.windowSeconds - elapsed };
        }
        return { available: true, remaining: quota.limit - used };
      } catch {
        return UNKNOWN;
      }
    },

    async peek(provider, scope) {
      const quota = quotas[provider];
      if (quota.limit === null || !store) return UNKNOWN;
      try {
        const raw = await store.get(keyFor(provider, scope, quota, now()));
        // Number(null) is 0: an untouched window has spent nothing.
        const used = Number(raw);
        if (!Number.isFinite(used)) return UNKNOWN;
        const remaining = Math.max(0, quota.limit - used);
        return { available: remaining > 0, remaining };
      } catch {
        return UNKNOWN;
      }
    },
  };
}
