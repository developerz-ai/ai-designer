import { describe, expect, it } from 'vitest';
import {
  type BudgetLimits,
  budgetNotice,
  budgetReason,
  DEFAULT_BUDGET,
  type StepUsageLike,
  TurnBudget,
  usageOf,
} from '@/agent/budget';

// budget.ts unit: the pure token/step math that becomes the loop's `stopWhen` conditions and
// the stop-and-summarize notice. No SDK, no chrome — structural `StepUsageLike` fixtures.

const LIMITS: BudgetLimits = { maxSteps: 3, maxTokens: 1000 };
const step = (input?: number, output?: number): StepUsageLike => ({
  usage: { inputTokens: input, outputTokens: output },
});

describe('usageOf', () => {
  it('sums input + output tokens and counts steps', () => {
    expect(usageOf([step(100, 20), step(300, 50)])).toEqual({ steps: 2, tokens: 470 });
  });

  it('treats a missing usage / missing count as zero tokens', () => {
    expect(usageOf([{}, step(undefined, 10), step(5)])).toEqual({ steps: 3, tokens: 15 });
  });

  it('is zero for no steps', () => {
    expect(usageOf([])).toEqual({ steps: 0, tokens: 0 });
  });
});

describe('budgetReason', () => {
  it('is null while within both ceilings', () => {
    expect(budgetReason({ steps: 2, tokens: 999 }, LIMITS)).toBeNull();
  });

  it('reports the token ceiling once tokens reach it', () => {
    expect(budgetReason({ steps: 1, tokens: 1000 }, LIMITS)).toBe('tokens');
  });

  it('reports the step ceiling once steps reach it', () => {
    expect(budgetReason({ steps: 3, tokens: 10 }, LIMITS)).toBe('steps');
  });

  it('steps win a tie when both ceilings are crossed at once', () => {
    expect(budgetReason({ steps: 3, tokens: 5000 }, LIMITS)).toBe('steps');
  });
});

describe('budgetNotice', () => {
  it('names the ceiling and what was spent, and invites continuing', () => {
    const notice = budgetNotice('tokens', { steps: 4, tokens: 12_345 });
    expect(notice).toContain('token budget');
    expect(notice).toContain('4 steps');
    expect(notice).toContain('12,345 tokens');
    expect(notice.toLowerCase()).toContain('continue');
  });

  it('says "step budget" for a step stop', () => {
    expect(budgetNotice('steps', { steps: 3, tokens: 0 })).toContain('step budget');
  });
});

describe('TurnBudget', () => {
  it('folds each step usage into the running totals', () => {
    const budget = new TurnBudget(LIMITS);
    budget.record({ inputTokens: 100, outputTokens: 20 });
    budget.record({ inputTokens: 200 });
    expect(budget.usage).toEqual({ steps: 2, tokens: 320 });
  });

  it('reports the token ceiling and a notice once tokens are exhausted', () => {
    const budget = new TurnBudget(LIMITS);
    budget.record({ inputTokens: 600, outputTokens: 500 }); // 1100 >= 1000
    expect(budget.exhausted).toBe(true);
    expect(budget.reason).toBe('tokens');
    expect(budget.notice()).toContain('token budget');
  });

  it('reports the step ceiling once the step count is exhausted', () => {
    const budget = new TurnBudget(LIMITS);
    for (let i = 0; i < 3; i += 1) budget.record({ inputTokens: 1 });
    expect(budget.reason).toBe('steps');
    expect(budget.exhausted).toBe(true);
  });

  it('stays within budget and returns a null notice below both ceilings', () => {
    const budget = new TurnBudget(LIMITS);
    budget.record({ inputTokens: 10, outputTokens: 5 });
    expect(budget.exhausted).toBe(false);
    expect(budget.reason).toBeNull();
    expect(budget.notice()).toBeNull();
  });

  it('defaults to DEFAULT_BUDGET when no limits are given', () => {
    expect(new TurnBudget().limits).toBe(DEFAULT_BUDGET);
  });
});
