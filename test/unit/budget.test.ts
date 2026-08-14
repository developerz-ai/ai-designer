import { describe, expect, it } from 'vitest';
import {
  BUDGET_WARN_FRACTION,
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
  contextWindow: 128_000,
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

  it('is honest about both halves (#168): the token figure is BILLED spend, and the pick-up promise is backed by the persisted thread', () => {
    const notice = budgetNotice('steps', usage(24, 180_000));
    // Summed input+output across steps is what the provider bills — say so, so the number
    // matches the user's invoice rather than looking inflated.
    expect(notice).toContain('tokens billed');
    // "Pick up where I left off" is only true because tool activity persists in the session
    // thread (TurnOutcome.responseMessages → compactForThread) — the notice leans on that.
    expect(notice).toMatch(/stays in our conversation/i);
    expect(notice).toMatch(/pick up where I left off/i);
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

// --- the one-shot mid-turn warning ------------------------------------------------------------
//
// THE DEFECT: the HN "make the page more modern" turn spent its entire 200k ceiling on 21 read
// calls across 3 steps and was force-stopped having changed NOTHING. The model was not exercising
// bad judgement — it announced an audit-first plan and executed it faithfully — it simply never
// learned that the plan had become unaffordable, because nothing in the loop ever told it what it
// had spent. "Stop and summarize" only ever arrived as a fait accompli.

describe('TurnBudget.warning', () => {
  const limits: BudgetLimits = { ...DEFAULT_BUDGET, maxTokens: 1000 };

  it('stays silent below the warn threshold', () => {
    const budget = new TurnBudget(limits);
    budget.record({ inputTokens: 500, outputTokens: 0 }); // 50% — still plenty of room
    expect(budget.warning()).toBeNull();
  });

  it('fires once spend crosses the threshold, and names the spend', () => {
    const budget = new TurnBudget(limits);
    budget.record({ inputTokens: 700, outputTokens: 0 });
    const warning = budget.warning();
    expect(warning).not.toBeNull();
    expect(warning).toContain('70%');
    // It must tell the model what to DO, not merely that it is spending.
    expect(warning).toContain('Stop surveying');
    // And why acting beats reading: only changes survive a stop.
    expect(warning).toContain('what you have CHANGED survives');
  });

  it('fires EXACTLY once, however far the spend goes afterwards', () => {
    // One-shot is load-bearing, not an optimisation: the warning is injected into the live
    // transcript, so re-emitting it every step would rewrite the prompt prefix every step and
    // invalidate the whole prompt cache each time. Firing once is a single invalidation.
    const budget = new TurnBudget(limits);
    budget.record({ inputTokens: 700, outputTokens: 0 });
    expect(budget.warning()).not.toBeNull();
    budget.record({ inputTokens: 200, outputTokens: 0 });
    expect(budget.warning()).toBeNull();
    budget.record({ inputTokens: 500, outputTokens: 0 });
    expect(budget.warning()).toBeNull();
  });

  it('leaves real room to act — it is not a death notice', () => {
    // Warning at 0.8 or 0.9 would arrive too late to change the outcome, which is the entire point
    // of warning at all. At 0.6 roughly 40% of the ceiling remains.
    expect(BUDGET_WARN_FRACTION).toBeLessThanOrEqual(0.7);
    expect(BUDGET_WARN_FRACTION).toBeGreaterThan(0.4);
  });
});
