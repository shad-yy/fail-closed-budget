import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryBudget } from '../src/index.js';

const BUDGETS = {
  movies: { limit: 240, windowMs: 60_000 },
  scores: { limit: 20, windowMs: 60_000 },
};

let t = 0;
const clock = () => t;
const make = () => createMemoryBudget(BUDGETS, { now: clock });

beforeEach(() => {
  t = 1_000_000;
});

const exhaust = (b: ReturnType<typeof make>, p: keyof typeof BUDGETS) => {
  for (let i = 0; i < BUDGETS[p].limit; i++) b.spend(p);
};

describe('spend', () => {
  it('allows calls up to the ceiling', () => {
    const b = make();
    for (let i = 0; i < BUDGETS.movies.limit; i++) expect(b.spend('movies'), `call ${i + 1}`).toBe(true);
  });

  it('refuses the call after the ceiling', () => {
    const b = make();
    exhaust(b, 'movies');
    expect(b.spend('movies')).toBe(false);
  });

  it('keeps refusing for the rest of the window', () => {
    const b = make();
    exhaust(b, 'scores');
    for (let i = 0; i < 5; i++) expect(b.spend('scores')).toBe(false);
  });

  it('keeps providers separate', () => {
    const b = make();
    exhaust(b, 'movies');
    expect(b.spend('movies')).toBe(false);
    expect(b.spend('scores')).toBe(true);
  });

  it('opens again exactly when the window ends', () => {
    const b = make();
    exhaust(b, 'scores');
    t += BUDGETS.scores.windowMs;
    expect(b.spend('scores')).toBe(true);
  });

  it('does not open one millisecond early', () => {
    const b = make();
    exhaust(b, 'scores');
    t += BUDGETS.scores.windowMs - 1;
    expect(b.spend('scores')).toBe(false);
  });

  it('starts the window at the first call, not at creation', () => {
    const b = make();
    t += 50_000;
    exhaust(b, 'scores');
    t += 15_000; // 65 s after creation, 15 s after the first call
    expect(b.spend('scores')).toBe(false);
  });

  it('gives a full allowance in the new window', () => {
    const b = make();
    exhaust(b, 'scores');
    t += BUDGETS.scores.windowMs;
    for (let i = 0; i < BUDGETS.scores.limit; i++) expect(b.spend('scores')).toBe(true);
    expect(b.spend('scores')).toBe(false);
  });

  it('allows a provider nobody configured instead of blocking it', () => {
    const b = make();
    for (let i = 0; i < 300; i++) expect(b.spend('typo' as never)).toBe(true);
    expect(b.remaining('typo' as never)).toBeNull();
  });

  it('uses the real clock by default', () => {
    const b = createMemoryBudget({ x: { limit: 1, windowMs: 60_000 } });
    expect(b.spend('x')).toBe(true);
    expect(b.spend('x')).toBe(false);
  });
});

describe('remaining', () => {
  it('counts down and resets with the window', () => {
    const b = make();
    expect(b.remaining('scores')).toBe(20);
    b.spend('scores');
    b.spend('scores');
    expect(b.remaining('scores')).toBe(18);
    exhaust(b, 'scores');
    expect(b.remaining('scores')).toBe(0);
    t += BUDGETS.scores.windowMs;
    expect(b.remaining('scores')).toBe(20);
  });
});

describe('reset', () => {
  it('actually clears state', () => {
    const b = make();
    exhaust(b, 'movies');
    expect(b.spend('movies')).toBe(false);
    b.reset();
    expect(b.spend('movies')).toBe(true);
  });
});

describe('configuration', () => {
  it.each([
    [{ limit: 0, windowMs: 1000 }, 'limit must be a whole number of at least 1'],
    [{ limit: 2.5, windowMs: 1000 }, 'limit must be a whole number of at least 1'],
    [{ limit: 5, windowMs: 0 }, 'windowMs must be greater than 0'],
    [{ limit: 5, windowMs: Number.NaN }, 'windowMs must be greater than 0'],
  ])('rejects %o', (budget, message) => {
    expect(() => createMemoryBudget({ bad: budget })).toThrow(new RangeError(`budget "bad": ${message}`));
  });

  it('accepts a limit of exactly 1', () => {
    expect(() => createMemoryBudget({ one: { limit: 1, windowMs: 1 } })).not.toThrow();
  });
});
