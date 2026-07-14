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

/** The two ceilings a turn runs under. */
export interface BudgetLimits {
  /** Max reasoning/tool steps before the turn is force-stopped. */
  readonly maxSteps: number;
  /** Max tokens (input + output, summed across every step) before the turn is force-stopped. */
  readonly maxTokens: number;
}

// Generous enough for a real design turn (several read→mutate→screenshot→correct→record
// cycles), low enough to cap a runaway. Per-model tuning can override at call time.
export const DEFAULT_BUDGET: BudgetLimits = { maxSteps: 24, maxTokens: 200_000 };

/** Why a turn stopped against its budget (`null` = still within budget). */
export type BudgetReason = 'steps' | 'tokens';

/** What a turn has spent so far. */
export interface BudgetUsage {
  readonly steps: number;
  readonly tokens: number;
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

/** Sum token spend and count steps across a turn's completed steps. */
export function usageOf(steps: readonly StepUsageLike[]): BudgetUsage {
  let tokens = 0;
  for (const step of steps) {
    tokens += (step.usage?.inputTokens ?? 0) + (step.usage?.outputTokens ?? 0);
  }
  return { steps: steps.length, tokens };
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

  constructor(readonly limits: BudgetLimits = DEFAULT_BUDGET) {}

  /** Fold one completed step's usage into the running totals. */
  record(usage?: StepUsageLike['usage']): void {
    this.steps += 1;
    this.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  }

  get usage(): BudgetUsage {
    return { steps: this.steps, tokens: this.tokens };
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
