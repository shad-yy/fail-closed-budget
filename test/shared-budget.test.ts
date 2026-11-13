import { describe, expect, it } from 'vitest';
import { type CounterStore, createSharedBudget } from '../src/index.js';

/** An in-memory stand-in for Redis that records what it was asked. */
function fakeStore() {
  const data = new Map<string, number>();
  const expiries: [string, number][] = [];
  const store: CounterStore = {
    async incr(key) {
      const v = (data.get(key) ?? 0) + 1;
      data.set(key, v);
      return v;
    },
    async expire(key, seconds) {
      expiries.push([key, seconds]);
      return 1;
    },
    async get(key) {
      return data.get(key) ?? null;
    },
  };
  return { store, data, expiries };
}

const brokenStore: CounterStore = {
  incr: () => Promise.reject(new Error('connection refused')),
  expire: () => Promise.reject(new Error('connection refused')),
  get: () => Promise.reject(new Error('connection refused')),
};

const QUOTAS = {
  scores: { limit: 3, windowSeconds: 60 },
  daily: { limit: 100, windowSeconds: 86_400 },
  open: { limit: null, windowSeconds: 60 },
};

// 10:00:20 UTC on some day: 20 seconds into a minute window.
const T = Date.UTC(2026, 0, 1, 10, 0, 20);

describe('claim', () => {
  it('counts down the remaining allowance', async () => {
    const { store } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    expect(await b.claim('scores')).toEqual({ available: true, remaining: 2 });
    expect(await b.claim('scores')).toEqual({ available: true, remaining: 1 });
    expect(await b.claim('scores')).toEqual({ available: true, remaining: 0 });
  });

  it('refuses past the limit and says when the window resets', async () => {
    const { store } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    for (let i = 0; i < 3; i++) await b.claim('scores');
    expect(await b.claim('scores')).toEqual({ available: false, remaining: 0, resetsIn: 40 });
  });

  it('sets the expiry once, on the first call of a window', async () => {
    const { store, expiries } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    await b.claim('scores');
    expect(expiries).toHaveLength(1);
    await b.claim('scores');
    expect(expiries).toEqual([[`budget:scores:${Math.floor(T / 1000 / 60)}`, 60]]);
  });

  it('uses a new key, and a full allowance, in the next window', async () => {
    const { store } = fakeStore();
    let now = T;
    const b = createSharedBudget(store, QUOTAS, { now: () => now });
    for (let i = 0; i < 4; i++) await b.claim('scores');
    now += 40_000; // 10:01:00
    expect(await b.claim('scores')).toEqual({ available: true, remaining: 2 });
  });

  it('keeps scopes apart within one provider', async () => {
    const { store, data } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    for (let i = 0; i < 4; i++) await b.claim('scores', 'football');
    expect(await b.claim('scores', 'basketball')).toMatchObject({ available: true, remaining: 2 });
    expect([...data.keys()].sort()).toEqual([
      `budget:scores:basketball:${Math.floor(T / 60_000)}`,
      `budget:scores:football:${Math.floor(T / 60_000)}`,
    ]);
  });

  it('honours a custom key prefix', async () => {
    const { store, data } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T, prefix: 'quota' });
    await b.claim('scores');
    expect([...data.keys()]).toEqual([`quota:scores:${Math.floor(T / 60_000)}`]);
  });

  it('never throttles a provider with no published limit', async () => {
    const { store, data } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    for (let i = 0; i < 50; i++) expect(await b.claim('open')).toEqual({ available: true, remaining: null });
    expect(data.size).toBe(0);
  });

  it('fails open when the store errors', async () => {
    const b = createSharedBudget(brokenStore, QUOTAS, { now: () => T });
    expect(await b.claim('scores')).toEqual({ available: true, remaining: null });
  });

  it('fails open when there is no store at all', async () => {
    const b = createSharedBudget(null, QUOTAS, { now: () => T });
    expect(await b.claim('scores')).toEqual({ available: true, remaining: null });
  });

  it('uses the real clock by default', async () => {
    const { store, data } = fakeStore();
    const b = createSharedBudget(store, QUOTAS);
    const before = Math.floor(Date.now() / 60_000);
    await b.claim('scores');
    const key = [...data.keys()][0]!;
    expect(Number(key.split(':').pop())).toBeGreaterThanOrEqual(before);
  });
});

describe('peek', () => {
  it('reads without spending', async () => {
    const { store } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    await b.claim('scores');
    expect(await b.peek('scores')).toEqual({ available: true, remaining: 2 });
    expect(await b.peek('scores')).toEqual({ available: true, remaining: 2 });
  });

  it('reports a full allowance for an untouched window', async () => {
    const { store } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    expect(await b.peek('daily')).toEqual({ available: true, remaining: 100 });
  });

  it('reports unavailable, never negative, once overspent', async () => {
    const { store } = fakeStore();
    const b = createSharedBudget(store, QUOTAS, { now: () => T });
    for (let i = 0; i < 5; i++) await b.claim('scores');
    expect(await b.peek('scores')).toEqual({ available: false, remaining: 0 });
  });

  it('reads a count stored as a string, as Redis clients often return', async () => {
    const b = createSharedBudget({ ...fakeStore().store, get: async () => '2' }, QUOTAS, { now: () => T });
    expect(await b.peek('scores')).toEqual({ available: true, remaining: 1 });
  });

  it('treats an unreadable count as unknown rather than as zero', async () => {
    const b = createSharedBudget({ ...fakeStore().store, get: async () => 'garbage' }, QUOTAS, { now: () => T });
    expect(await b.peek('scores')).toEqual({ available: true, remaining: null });
  });

  it('fails open when the store errors, or is missing, or the provider is unlimited', async () => {
    expect(await createSharedBudget(brokenStore, QUOTAS).peek('scores')).toEqual({ available: true, remaining: null });
    expect(await createSharedBudget(null, QUOTAS).peek('scores')).toEqual({ available: true, remaining: null });
    expect(await createSharedBudget(fakeStore().store, QUOTAS).peek('open')).toEqual({ available: true, remaining: null });
  });
});
