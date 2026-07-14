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
// the stop-and-summarize notice, plus the per-tool vision/wait/nav guards `loop.ts` wraps around
// the interact/vision dispatches. No SDK, no chrome — structural `StepUsageLike` fixtures.

const LIMITS: BudgetLimits = {
  maxSteps: 3,
  maxTokens: 1000,
  maxVisionCalls: 2,
  maxWaitCalls: 2,
  maxNavCalls: 2,
};
const step = (input?: number, output?: number): StepUsageLike => ({
  usage: { inputTokens: input, outputTokens: output },
});

describe('usageOf', () => {
  it('sums input + output tokens and counts steps', () => {
    expect(usageOf([step(100, 20), step(300, 50)])).toEqual({
      steps: 2,
      tokens: 470,
      visionCalls: 0,
      waitCalls: 0,
      navCalls: 0,
    });
  });

  it('treats a missing usage / missing count as zero tokens', () => {
    expect(usageOf([{}, step(undefined, 10), step(5)])).toEqual({
      steps: 3,
      tokens: 15,
      visionCalls: 0,
      waitCalls: 0,
      navCalls: 0,
    });
  });

  it('is zero for no steps', () => {
    expect(usageOf([])).toEqual({
      steps: 0,
      tokens: 0,
      visionCalls: 0,
      waitCalls: 0,
      navCalls: 0,
    });
  });
});

describe('budgetReason', () => {
  const usage = (steps: number, tokens: number) => ({
    steps,
    tokens,
    visionCalls: 0,
    waitCalls: 0,
    navCalls: 0,
  });

  it('is null while within both ceilings', () => {
    expect(budgetReason(usage(2, 999), LIMITS)).toBeNull();
  });

  it('reports the token ceiling once tokens reach it', () => {
    expect(budgetReason(usage(1, 1000), LIMITS)).toBe('tokens');
  });

  it('reports the step ceiling once steps reach it', () => {
    expect(budgetReason(usage(3, 10), LIMITS)).toBe('steps');
  });

  it('steps win a tie when both ceilings are crossed at once', () => {
    expect(budgetReason(usage(3, 5000), LIMITS)).toBe('steps');
  });
});

describe('budgetNotice', () => {
  const usage = (steps: number, tokens: number) => ({
    steps,
    tokens,
    visionCalls: 0,
    waitCalls: 0,
    navCalls: 0,
  });

  it('names the ceiling and what was spent, and invites continuing', () => {
    const notice = budgetNotice('tokens', usage(4, 12_345));
    expect(notice).toContain('token budget');
    expect(notice).toContain('4 steps');
    expect(notice).toContain('12,345 tokens');
    expect(notice.toLowerCase()).toContain('continue');
  });

  it('says "step budget" for a step stop', () => {
    expect(budgetNotice('steps', usage(3, 0))).toContain('step budget');
  });
});

describe('TurnBudget', () => {
  it('folds each step usage into the running totals', () => {
    const budget = new TurnBudget(LIMITS);
    budget.record({ inputTokens: 100, outputTokens: 20 });
    budget.record({ inputTokens: 200 });
    expect(budget.usage).toEqual({
      steps: 2,
      tokens: 320,
      visionCalls: 0,
      waitCalls: 0,
      navCalls: 0,
    });
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
    expect(new TurnBudget().limits).toEqual(DEFAULT_BUDGET);
  });

  it('merges partial limits over DEFAULT_BUDGET', () => {
    expect(new TurnBudget({ maxSteps: 1 }).limits).toEqual({ ...DEFAULT_BUDGET, maxSteps: 1 });
  });

  describe('spendVision / spendWait / spendNav — per-tool guards', () => {
    it('spendVision allows up to maxVisionCalls, then refuses without counting further', () => {
      const budget = new TurnBudget(LIMITS); // maxVisionCalls: 2
      expect(budget.spendVision()).toBe(true);
      expect(budget.spendVision()).toBe(true);
      expect(budget.spendVision()).toBe(false);
      expect(budget.spendVision()).toBe(false);
      expect(budget.usage.visionCalls).toBe(2);
    });

    it('spendWait allows up to maxWaitCalls, then refuses', () => {
      const budget = new TurnBudget(LIMITS); // maxWaitCalls: 2
      expect(budget.spendWait()).toBe(true);
      expect(budget.spendWait()).toBe(true);
      expect(budget.spendWait()).toBe(false);
      expect(budget.usage.waitCalls).toBe(2);
    });

    it('spendNav allows up to maxNavCalls, then refuses', () => {
      const budget = new TurnBudget(LIMITS); // maxNavCalls: 2
      expect(budget.spendNav()).toBe(true);
      expect(budget.spendNav()).toBe(true);
      expect(budget.spendNav()).toBe(false);
      expect(budget.usage.navCalls).toBe(2);
    });

    it('the three guard counters are independent of each other and of steps/tokens', () => {
      const budget = new TurnBudget(LIMITS);
      budget.spendVision();
      budget.spendWait();
      budget.record({ inputTokens: 5 });
      expect(budget.usage).toEqual({
        steps: 1,
        tokens: 5,
        visionCalls: 1,
        waitCalls: 1,
        navCalls: 0,
      });
      expect(budget.exhausted).toBe(false); // guard spend never trips the turn-level stop
    });
  });
});
