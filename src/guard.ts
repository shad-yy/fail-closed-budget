import type { MemoryBudget } from './memory-budget.js';
import type { SharedBudget } from './shared-budget.js';

/**
 * Thrown when a call is refused by a budget.
 *
 * A refusal is a fault, never an empty result. If the caller turned it into
 * "no matches", the page would claim it asked and found nothing, when it chose
 * not to ask.
 */
export class BudgetRefused extends Error {
  readonly provider: string;
  readonly layer: 'memory' | 'shared';
  readonly resetsIn: number | undefined;

  constructor(provider: string, layer: 'memory' | 'shared', resetsIn?: number) {
    super(`${provider}: call refused by the ${layer} budget`);
    this.name = 'BudgetRefused';
    this.provider = provider;
    this.layer = layer;
    this.resetsIn = resetsIn;
  }
}

/**
 * Run `call` only if both budgets allow it.
 *
 * The in-memory ceiling is checked first: it fails closed and costs nothing.
 * The shared quota is checked second: it fails open if the store is down.
 */
export async function guarded<P extends string, T>(
  provider: P,
  call: () => Promise<T>,
  budgets: { memory?: MemoryBudget<P>; shared?: SharedBudget<P>; scope?: string },
): Promise<T> {
  if (budgets.memory && !budgets.memory.spend(provider)) {
    throw new BudgetRefused(provider, 'memory');
  }
  if (budgets.shared) {
    const state = await budgets.shared.claim(provider, budgets.scope);
    if (!state.available) throw new BudgetRefused(provider, 'shared', state.resetsIn);
  }
  return call();
}
