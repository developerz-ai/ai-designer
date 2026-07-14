// Per-turn budget for the agent loop: a hard step ceiling and a token ceiling. One user
// instruction runs an autonomous multi-step turn (read → mutate → screenshot → self-correct →
// record), so it MUST be bounded — otherwise a confused model loops or burns tokens forever
// (docs/architecture/agent-loop.md "Budgets & guardrails", docs/idea/agent.md). On a ceiling
// the loop stops and summarizes rather than continuing.
//
// Pure + chrome-free + no `any`. Decoupled from the AI SDK on purpose: `usageOf` reads a
// minimal structural shape, so it scores both a live `StepResult` (loop) and a plain fixture
// (test) without importing SDK types. `loop.ts` turns these numbers into the agent's
// `stopWhen` conditions and, on exhaustion, the stop notice streamed to the panel.

/** The ceilings a turn runs under. `maxSteps`/`maxTokens` stop the whole turn (checked by the
 *  loop's `stopWhen`, via `usageOf`/`budgetReason`). `maxVisionCalls`/`maxWaitCalls`/`maxNavCalls`
 *  are narrower per-tool guards enforced by the tool wrappers themselves (`loop.ts`
 *  `guardVision`/`guardInteract`): exceeding one fails just that call with an error ToolResult the
 *  model reacts to, rather than ending the turn — a runaway `waitFor`/`navigate` loop or a chatty
 *  `inspectVisually` shouldn't burn the whole step/token budget before the model notices. */
export interface BudgetLimits {
  /** Max reasoning/tool steps before the turn is force-stopped. */
  readonly maxSteps: number;
  /** Max tokens (input + output, summed across every step) before the turn is force-stopped. */
  readonly maxTokens: number;
  /** Max `inspectVisually` calls — each is an extra vision-model round-trip invisible to the step/
   *  token ceilings above (it doesn't go through `onStepFinish`), so it needs its own cap. */
  readonly maxVisionCalls: number;
  /** Max `waitFor` calls — each blocks up to 30s; caps a stuck page from being re-waited forever. */
  readonly maxWaitCalls: number;
  /** Max `navigate` / `navigateBack` / `reload` calls — caps a confused agent bouncing between
   *  pages instead of making progress. */
  readonly maxNavCalls: number;
}

// Generous enough for a real design turn (several read→mutate→screenshot→correct→record
// cycles), low enough to cap a runaway. Per-model tuning can override at call time.
export const DEFAULT_BUDGET: BudgetLimits = {
  maxSteps: 24,
  maxTokens: 200_000,
  maxVisionCalls: 6,
  maxWaitCalls: 10,
  maxNavCalls: 8,
};

/** Why a turn stopped against its budget (`null` = still within budget). */
export type BudgetReason = 'steps' | 'tokens';

/** What a turn has spent so far. The three per-tool counters are guard spend (see
 *  {@link BudgetLimits}), not step/token spend — a turn can be well within budget on `steps`/
 *  `tokens` and still have a tool refuse because it re-ran `waitFor`/`inspectVisually` too many
 *  times. */
export interface BudgetUsage {
  readonly steps: number;
  readonly tokens: number;
  readonly visionCalls: number;
  readonly waitCalls: number;
  readonly navCalls: number;
}

// The only field of a step the budget reads: its token usage. Structural so both the SDK's
// `StepResult` (`usage: LanguageModelUsage`) and a test fixture satisfy it; every field is
// optional because a provider may omit counts (usage accounting off) — a missing count is 0.
export interface StepUsageLike {
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

/** Sum token spend and count steps across a turn's completed steps. The per-tool guard counters
 *  aren't derivable from steps (they're not folded from `StepResult.usage`), so they read 0 here —
 *  callers that need them read `TurnBudget.usage` instead, which tracks all five fields. */
export function usageOf(steps: readonly StepUsageLike[]): BudgetUsage {
  let tokens = 0;
  for (const step of steps) {
    tokens += (step.usage?.inputTokens ?? 0) + (step.usage?.outputTokens ?? 0);
  }
  return { steps: steps.length, tokens, visionCalls: 0, waitCalls: 0, navCalls: 0 };
}

/** Which ceiling `usage` has reached under `limits`, or `null` if still within budget. Steps
 *  win ties: a step-capped turn reports `'steps'` even if it also crossed the token cap. */
export function budgetReason(usage: BudgetUsage, limits: BudgetLimits): BudgetReason | null {
  if (usage.steps >= limits.maxSteps) return 'steps';
  if (usage.tokens >= limits.maxTokens) return 'tokens';
  return null;
}

/** The concise notice streamed to the panel when a turn is force-stopped on budget — the
 *  "stop and summarize" half of the guardrail. Speaks to the user, names what was spent. */
export function budgetNotice(reason: BudgetReason, usage: BudgetUsage): string {
  const spent = `${usage.steps} steps, ~${usage.tokens.toLocaleString('en-US')} tokens`;
  const limit = reason === 'steps' ? 'step' : 'token';
  return (
    `I've reached this turn's ${limit} budget (${spent}), so I'm stopping here. ` +
    `Tell me to continue and I'll pick up where I left off.`
  );
}

/**
 * Running tally of one turn's spend, folded from each step's usage as the loop streams. The
 * loop reads `reason`/`notice` once the stream ends to decide whether it was force-stopped and
 * what to tell the user; `usage` is persisted to the session so a resumed turn keeps its spend.
 * Stateful sibling of the pure helpers above — both sum usage identically.
 */
export class TurnBudget {
  private steps = 0;
  private tokens = 0;
  private visionCalls = 0;
  private waitCalls = 0;
  private navCalls = 0;

  readonly limits: BudgetLimits;

  /** Partial limits merge over {@link DEFAULT_BUDGET} — a caller (or test) can override just the
   *  ceiling it cares about without restating the rest. */
  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
  }

  /** Fold one completed step's usage into the running totals. */
  record(usage?: StepUsageLike['usage']): void {
    this.steps += 1;
    this.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  }

  /** Claim one `inspectVisually` round-trip. `true` and counts it if still under
   *  `maxVisionCalls`; `false` (uncounted) once the cap is reached — the caller returns a guard
   *  error instead of spending another vision-model call. */
  spendVision(): boolean {
    if (this.visionCalls >= this.limits.maxVisionCalls) return false;
    this.visionCalls += 1;
    return true;
  }

  /** Claim one `waitFor` call. Same shape as {@link spendVision}, capped by `maxWaitCalls`. */
  spendWait(): boolean {
    if (this.waitCalls >= this.limits.maxWaitCalls) return false;
    this.waitCalls += 1;
    return true;
  }

  /** Claim one `navigate` / `navigateBack` / `reload` call. Same shape, capped by `maxNavCalls`. */
  spendNav(): boolean {
    if (this.navCalls >= this.limits.maxNavCalls) return false;
    this.navCalls += 1;
    return true;
  }

  get usage(): BudgetUsage {
    return {
      steps: this.steps,
      tokens: this.tokens,
      visionCalls: this.visionCalls,
      waitCalls: this.waitCalls,
      navCalls: this.navCalls,
    };
  }

  /** Which ceiling has been hit, or `null` if the turn is still within budget. */
  get reason(): BudgetReason | null {
    return budgetReason(this.usage, this.limits);
  }

  get exhausted(): boolean {
    return this.reason !== null;
  }

  /** The stop notice for the current spend, or `null` if still within budget. */
  notice(): string | null {
    const reason = this.reason;
    return reason ? budgetNotice(reason, this.usage) : null;
  }
}
