import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryBudget } from '../src/index.js';

describe('properties of the in-memory ceiling', () => {
  it('matches a reference model of a fixed window on every call, whatever the timing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(fc.integer({ min: 0, max: 3_000 }), { minLength: 1, maxLength: 300 }),
        (limit, windowMs, gaps) => {
          // A window opens at the first call after the last one expired, and admits `limit` calls.
          let model = { count: 0, start: -Infinity };
          let mt = 0;
          const b2 = createMemoryBudget({ p: { limit, windowMs } }, { now: () => mt });
          for (const gap of gaps) {
            mt += gap;
            let expected: boolean;
            if (mt - model.start >= windowMs) {
              model = { count: 1, start: mt };
              expected = true;
            } else if (model.count >= limit) {
              expected = false;
            } else {
              model.count += 1;
              expected = true;
            }
            expect(b2.spend('p')).toBe(expected);
          }
        },
      ),
    );
  });

  it('always allows the first call after a full idle window', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 100 }), (limit, windowMs, burst) => {
        let t = 0;
        const b = createMemoryBudget({ p: { limit, windowMs } }, { now: () => t });
        for (let i = 0; i < burst; i++) b.spend('p');
        t += windowMs;
        expect(b.spend('p')).toBe(true);
      }),
    );
  });

  it('remaining always equals limit minus the calls allowed in the current window', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 60 }), (limit, calls) => {
        const b = createMemoryBudget({ p: { limit, windowMs: 60_000 } }, { now: () => 0 });
        let allowed = 0;
        for (let i = 0; i < calls; i++) if (b.spend('p')) allowed++;
        expect(allowed).toBe(Math.min(calls, limit));
        expect(b.remaining('p')).toBe(limit - allowed);
      }),
    );
  });
});
