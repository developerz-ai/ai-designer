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
//
// The import below is TYPE-ONLY and erased at compile time — this module stays runtime-free of
// zod/chrome/SDK. The `BudgetPreset` vocabulary lives in the shared message hub because it
// crosses the bus (persisted on `ProviderConfig`, chosen in Settings); the preset → ceilings
// MAPPING lives here (`budgetForPreset`) because it is agent policy, mirroring `Mode` (schema
// in messages.ts, interpretation in modes.ts).

import type { BudgetPreset } from '@/shared/messages';

/** The ceilings a turn runs under. `maxSteps`/`maxTokens` stop the whole turn (checked by the
 *  loop's `stopWhen`, via `usageOf`/`budgetReason`). `maxVisionCalls`/`maxWaitCalls`/`maxNavCalls`
 *  are narrower per-tool guards enforced by the tool wrappers themselves (`loop.ts`
 *  `guardVision`/`guardInteract`): exceeding one fails just that call with an error ToolResult the
 *  model reacts to, rather than ending the turn — a runaway `waitFor`/`navigate` loop or a chatty
 *  `inspectVisually` shouldn't burn the whole step/token budget before the model notices. */
export interface BudgetLimits {
  /** Max reasoning/tool steps before the turn is force-stopped. */
  readonly maxSteps: number;
  /** Max tokens (input + output, summed across every step) before the turn is force-stopped.
   *  Summed input+output IS the billed spend, kept deliberately: every step re-sends the whole
   *  transcript as input, and the provider charges for each of those sends — so a cap on
   *  "distinct" tokens would under-count exactly the runaway (a long transcript re-uploaded
   *  every step) this ceiling exists to stop. */
  readonly maxTokens: number;
  /** Max `inspectVisually` calls — each is an extra vision-model round-trip invisible to the step/
   *  token ceilings above (it doesn't go through `onStepFinish`), so it needs its own cap. */
  readonly maxVisionCalls: number;
  /** Max `waitFor` calls — each blocks up to 30s; caps a stuck page from being re-waited forever. */
  readonly maxWaitCalls: number;
  /** Max `navigate` / `navigateBack` / `reload` calls — caps a confused agent bouncing between
   *  pages instead of making progress. */
  readonly maxNavCalls: number;
  /**
   * The model's context window in tokens — a DIFFERENT QUESTION from {@link maxTokens}, which is
   * why both exist rather than one replacing the other:
   *
   *   • `maxTokens` is COST-shaped. It sums input+output across every step, so it grows without
   *     bound as a turn works and answers "how much is this turn allowed to spend".
   *   • `contextWindow` is CAPACITY-shaped. It bounds ONE request's prompt, never accumulates, and
   *     answers "will the next request fit". Exceeding it is not an expensive turn, it is a hard
   *     provider error mid-turn.
   *
   * Collapsing them would break in both directions: a 1M-context model would be held to a fifth of
   * its capacity by a cost cap, and a 32k model would sail past the wall because its cost cap was
   * nowhere near spent. Captured per model at save time (`provider.ts` `resolveContextWindow`,
   * persisted on `ProviderConfig`), falling back to {@link DEFAULT_CONTEXT_WINDOW}.
   */
  readonly contextWindow: number;
}

/**
 * Context window assumed when the provider doesn't report one.
 *
 * DERIVATION: this is a FALLBACK, so it is sized to be safe on the small end rather than accurate
 * on the large end — under-estimating costs some avoidable compaction, over-estimating costs a hard
 * mid-turn provider error that loses the turn. 128k is the floor of what current mainstream
 * chat models ship (GPT-4o/4.1, Claude 3.5+, Llama 3.1+, Qwen 2.5+ are all at or above it), so a
 * gateway that reports nothing is very unlikely to be below it, while a genuinely small local model
 * (an 8k llama.cpp build) reports `n_ctx` and is detected properly. NOT a target and not tuning —
 * the real value is detected; this only covers endpoints with no model catalogue.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

// The `standard` tier's ceilings, and the merge base `TurnBudget` falls back to for any field a
// caller's partial limits omit. NOTE: this is NOT the shipped product default any more — the
// shipped default preset is `unlimited` (`DEFAULT_BUDGET_PRESET`, resolved where the persisted
// config is read); these numbers remain the opt-in `standard` cost control and the deterministic
// fallback for callers/tests that pass partial limits.
export const DEFAULT_BUDGET: BudgetLimits = {
  maxSteps: 24,
  maxTokens: 200_000,
  maxVisionCalls: 6,
  maxWaitCalls: 10,
  maxNavCalls: 8,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
};

/** The ceilings one preset buys — everything in {@link BudgetLimits} EXCEPT `contextWindow`.
 *  Deliberately `Omit`, not a full `BudgetLimits`: the context window is DETECTED per model at
 *  save time (capacity-shaped) and a preset (cost-shaped) must never override it — returning a
 *  full object here would smuggle a default window over the detected one at the merge site. */
export type PresetLimits = Omit<BudgetLimits, 'contextWindow'>;

// `standard` derives from DEFAULT_BUDGET (they are the same tier — one source, no drift).
const { contextWindow: _defaultWindow, ...STANDARD_LIMITS } = DEFAULT_BUDGET;

/** The user-facing budget tiers (chosen in Settings, persisted on `ProviderConfig`).
 *
 *  `standard`/`high`/`max` are opt-in COST CONTROLS at ~1×/3×/10×: hard ceilings for users who
 *  want a runaway turn capped at a known spend. `unlimited` — the SHIPPED DEFAULT — has no
 *  ceilings at all: every field is `Infinity`, so `budgetReason` never fires, the one-shot
 *  budget warning never injects, and the per-tool guards always admit the call. THE STOP BUTTON
 *  IS THE ONLY GUARD on an unlimited turn: a stuck loop runs — and bills the user's own key,
 *  re-sending the whole transcript every step — until the user presses Stop. That trade is
 *  deliberate product policy: this product optimizes for output quality, not token savings; a
 *  ceiling that stops a design turn mid-thought, or a warning that nudges the model to wrap up
 *  early, buys cost savings with worse output — the wrong default here. Infinity (not a huge
 *  finite number) so the arithmetic stays exact: `finite >= Infinity` is false, `Infinity *
 *  BUDGET_WARN_FRACTION` is Infinity — no ceiling is ever "almost" reached. */
const PRESET_LIMITS: Record<BudgetPreset, PresetLimits> = {
  standard: STANDARD_LIMITS,
  // ~3× tokens; steps and the per-tool guards scale to keep long turns from tripping a narrow
  // guard long before the token ceiling is a concern.
  high: {
    maxSteps: 48,
    maxTokens: 600_000,
    maxVisionCalls: 12,
    maxWaitCalls: 20,
    maxNavCalls: 16,
  },
  // ~10× tokens — sized for 1M+-context models on vision-heavy turns. Still a CAP, for users
  // who opt into cost control but want it far away.
  max: {
    maxSteps: 96,
    maxTokens: 2_000_000,
    maxVisionCalls: 24,
    maxWaitCalls: 40,
    maxNavCalls: 24,
  },
  unlimited: {
    maxSteps: Number.POSITIVE_INFINITY,
    maxTokens: Number.POSITIVE_INFINITY,
    maxVisionCalls: Number.POSITIVE_INFINITY,
    maxWaitCalls: Number.POSITIVE_INFINITY,
    maxNavCalls: Number.POSITIVE_INFINITY,
  },
};

/** Map a persisted preset to the ceilings a turn runs under. Pure; never returns (or touches)
 *  `contextWindow` — the caller merges the detected window in beside these (background.ts's
 *  `limits` construction). Returns a fresh object so a caller mutating its limits (tests do)
 *  can't corrupt the table. */
export function budgetForPreset(preset: BudgetPreset): PresetLimits {
  return { ...PRESET_LIMITS[preset] };
}

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
 *  win ties: a step-capped turn reports `'steps'` even if it also crossed the token cap.
 *  Infinity-clean by construction: on the `unlimited` preset both ceilings are `Infinity`, and
 *  `finite >= Infinity` is exactly `false` — always `null`, no special case, no NaN. */
export function budgetReason(usage: BudgetUsage, limits: BudgetLimits): BudgetReason | null {
  if (usage.steps >= limits.maxSteps) return 'steps';
  if (usage.tokens >= limits.maxTokens) return 'tokens';
  return null;
}

/** Fraction of the token ceiling at which the model is told, ONCE, that it is running out.
 *
 *  DERIVATION (2026-08-14): the HN "make the page more modern" turn spent its entire 200k ceiling
 *  on 21 read calls across 3 steps and was force-stopped having changed nothing. It had no way to
 *  know — nothing in the loop ever told the model what it had spent, so "stop and summarize" only
 *  ever arrived as a fait accompli. 0.6 is chosen to leave ~40% of the ceiling (≈80k tokens, in
 *  practice several steps) for the model to actually ACT after the warning: warning at 0.8 or 0.9
 *  would arrive too late to change the outcome, which is the whole point of warning at all.
 *  Re-measure against real turns before moving it. */
export const BUDGET_WARN_FRACTION = 0.6;

/** The one-shot mid-turn nudge. Phrased as a fact plus a directive, because the observed failure
 *  was not ignorance of good practice — the model announced an audit-first plan and followed it —
 *  but never learning that the plan had become unaffordable. Deliberately short: it is injected
 *  into the live transcript and then re-sent on every remaining step. */
export function budgetWarning(usage: BudgetUsage, limits: BudgetLimits): string {
  const pct = Math.round((usage.tokens / limits.maxTokens) * 100);
  return (
    `[Budget: you have used ~${pct}% of this turn's token budget on ${usage.steps} steps, and ` +
    'reading is what spends it — every result you have collected is re-sent on every step from ' +
    'here. Stop surveying now. Make the highest-impact change you can already justify, verify it, ' +
    'and record it. If you run out, what you have CHANGED survives; what you have merely read ' +
    'does not.]'
  );
}

/** The concise notice streamed to the panel when a turn is force-stopped on budget — the
 *  "stop and summarize" half of the guardrail. Speaks to the user, names what was spent (the
 *  token figure is billed spend: input + output summed across every step — see
 *  {@link BudgetLimits.maxTokens}). The "pick up where I left off" promise is real: the turn's
 *  tool calls and results persist in the session thread (`TurnOutcome.responseMessages` →
 *  `compactForThread`), so a follow-up "continue" resumes from that state instead of replaying
 *  the turn blind. */
export function budgetNotice(reason: BudgetReason, usage: BudgetUsage): string {
  const spent = `${usage.steps} steps, ~${usage.tokens.toLocaleString('en-US')} tokens billed`;
  const limit = reason === 'steps' ? 'step' : 'token';
  return (
    `I've reached this turn's ${limit} budget (${spent}), so I'm stopping here. ` +
    `What I've done and found so far stays in our conversation — ` +
    `tell me to continue and I'll pick up where I left off.`
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

  private warned = false;

  /**
   * The one-shot mid-turn budget warning once spend crosses {@link BUDGET_WARN_FRACTION}, or `null`
   * — every call after the first returns `null`, whatever the spend.
   *
   * ONE-SHOT IS THE POINT, not an optimisation. The warning is injected into the live transcript,
   * so re-emitting it every step would rewrite the prompt prefix on every step and invalidate the
   * whole prompt cache each time (`thread-compact.ts`'s prefix-cache policy). Firing once is a
   * single invalidation, after which the prefix is stable again — and a warning repeated every step
   * reads as noise the model learns to skip anyway.
   *
   * NEVER FIRES on the `unlimited` preset, arithmetically: `Infinity * BUDGET_WARN_FRACTION` is
   * `Infinity`, and any finite spend is `<` it — so the threshold check below returns `null`
   * forever, and no "[Budget: …% used]" line (whose percentage would be a meaningless 0 against
   * an infinite ceiling) ever nudges an unlimited turn to wrap up early. That silence is the
   * unlimited tier's whole point (see PRESET_LIMITS): quality over cost, Stop as the only guard.
   */
  warning(): string | null {
    if (this.warned) return null;
    if (this.tokens < this.limits.maxTokens * BUDGET_WARN_FRACTION) return null;
    this.warned = true;
    return budgetWarning(this.usage, this.limits);
  }
}
