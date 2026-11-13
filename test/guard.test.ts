import { describe, expect, it, vi } from 'vitest';
import { BudgetRefused, type CounterStore, createMemoryBudget, createSharedBudget, guarded } from '../src/index.js';

const brokenStore: CounterStore = {
  incr: () => Promise.reject(new Error('down')),
  expire: () => Promise.reject(new Error('down')),
  get: () => Promise.reject(new Error('down')),
};

describe('guarded', () => {
  it('makes the call when both budgets allow it', async () => {
    const memory = createMemoryBudget({ api: { limit: 2, windowMs: 60_000 } });
    const shared = createSharedBudget(null, { api: { limit: 5, windowSeconds: 60 } });
    await expect(guarded('api', async () => 'data', { memory, shared })).resolves.toBe('data');
  });

  it('works with no budgets at all', async () => {
    await expect(guarded('api', async () => 42, {})).resolves.toBe(42);
  });

  it('refuses with a fault, and never calls upstream, once the memory ceiling is spent', async () => {
    const memory = createMemoryBudget({ api: { limit: 1, windowMs: 60_000 } });
    const call = vi.fn(async () => 'data');
    await guarded('api', call, { memory });
    const refused = guarded('api', call, { memory });
    await expect(refused).rejects.toBeInstanceOf(BudgetRefused);
    await expect(refused).rejects.toMatchObject({
      name: 'BudgetRefused',
      provider: 'api',
      layer: 'memory',
      resetsIn: undefined,
      message: 'api: call refused by the memory budget',
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('still holds the ceiling when the shared store is down: the whole point', async () => {
    const memory = createMemoryBudget({ api: { limit: 3, windowMs: 60_000 } });
    const shared = createSharedBudget(brokenStore, { api: { limit: 1000, windowSeconds: 60 } });
    const call = vi.fn(async () => 'data');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => guarded('api', call, { memory, shared })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('refuses when the shared quota is spent, with the reset time', async () => {
    const counts = new Map<string, number>();
    const store: CounterStore = {
      incr: async (k) => {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k)!;
      },
      expire: async () => 1,
      get: async (k) => counts.get(k) ?? null,
    };
    const now = () => Date.UTC(2026, 0, 1, 10, 0, 45);
    const shared = createSharedBudget(store, { api: { limit: 1, windowSeconds: 60 } }, { now });
    await guarded('api', async () => 1, { shared });
    await expect(guarded('api', async () => 1, { shared })).rejects.toMatchObject({ layer: 'shared', resetsIn: 15 });
  });

  it('passes the scope to the shared budget', async () => {
    const shared = { claim: vi.fn(async () => ({ available: true, remaining: 1 })), peek: vi.fn() };
    await guarded('api', async () => 1, { shared, scope: 'football' });
    expect(shared.claim).toHaveBeenCalledWith('api', 'football');
  });

  it('checks memory before spending shared quota', async () => {
    const memory = createMemoryBudget({ api: { limit: 1, windowMs: 60_000 } });
    const shared = { claim: vi.fn(async () => ({ available: true, remaining: 1 })), peek: vi.fn() };
    await guarded('api', async () => 1, { memory, shared });
    await expect(guarded('api', async () => 1, { memory, shared })).rejects.toBeInstanceOf(BudgetRefused);
    expect(shared.claim).toHaveBeenCalledTimes(1);
  });
});
