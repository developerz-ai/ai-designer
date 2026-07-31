// Copy-site / debug-site modes (plan 06). The two headline activities `system-prompt.ts`'s
// `MODES` section already describes generically; this module supplies the PER-TURN addendum
// that sharpens that base prose into a concrete directive for the mode actually in play, plus
// which tools the agent should reach for first. Pure string/logic builder: no chrome.*, no I/O,
// no `any` — unit-testable and deterministic, exactly like `system-prompt.ts`.
//
// SW-ONLY by usage (the loop composes `instructions` before each turn), but chrome-free by
// construction.

import type { Mode } from '@/shared/messages';
import type { SystemPromptOptions } from './system-prompt';

export type { Mode };

// --- mode inference --------------------------------------------------------
// A composer affordance (11) can set `UserMessage.mode` explicitly; absent that, infer from the
// instruction text so a bare "debug my checkout flow" still gets the right addendum with no
// forced UI step (docs/idea/agent.md: "agent does the work, asks only when ambiguous"). Debug
// keywords are checked first: a "copy the bug report" style sentence is far rarer than a debug
// instruction that happens to also mention a reference/design word, and getting debug mode is the
// more consequential miss (a debug turn run as a design turn skips the diagnostics collector).
// Matching is WORD-BOUNDED (#168): plain `includes` fired 'fix' inside "prefix" and 'like'
// inside "unlike", flipping unrelated turns into debug/copy mode.
const DEBUG_KEYWORDS = [
  'debug',
  'broken',
  'fix',
  'bug',
  'error',
  'crash',
  'not working',
  "doesn't work",
  'does not work',
  'console error',
  'why is',
  "why isn't",
  'diagnose',
];

const COPY_KEYWORDS = [
  'copy',
  'clone',
  'like',
  'inspired by',
  'redesign',
  'design ideas',
  'make it look',
  'match the style',
  'reference site',
  'competitor',
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asMatchers = (keywords: readonly string[]): RegExp[] =>
  keywords.map((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i'));

const DEBUG_MATCHERS = asMatchers(DEBUG_KEYWORDS);
const COPY_MATCHERS = asMatchers(COPY_KEYWORDS);

/** Best-effort mode from free text — the same heuristic a human skimming the instruction would
 *  use, word-bounded so 'fix' never fires inside "prefix". When neither vocabulary shows up,
 *  falls back to `previous` — the mode the SESSION last ran under (`TurnSession.lastMode`) —
 *  because a follow-up like "now the header too" continues the same activity; mode was
 *  previously re-inferred from each message alone, so every follow-up silently dropped the
 *  debug/copy addendum. Returns `undefined` only when there's no signal at all (a generic
 *  edit): the base prompt covers that, so no addendum is the correct answer, not a failure. */
export function inferMode(text: string, previous?: Mode): Mode | undefined {
  if (DEBUG_MATCHERS.some((m) => m.test(text))) return 'debug';
  if (COPY_MATCHERS.some((m) => m.test(text))) return 'copy';
  return previous;
}

/** An explicit `mode` always wins; only fall back to inference (then to the session's previous
 *  mode) when the caller (or the composer) didn't set one. */
export function resolveMode(
  explicit: Mode | undefined,
  text: string,
  previous?: Mode,
): Mode | undefined {
  return explicit ?? inferMode(text, previous);
}

// --- prompt addenda + tool emphasis ----------------------------------------

const COPY_ADDENDUM = `**This turn is a copy/design task.** Read the reference's identity first —
call \`extractIdentity\` on it (role-tagged palette + type scale + spacing/radius/shadow rhythm),
browsing it in a background tab (\`browse\`) when it's a live site — before touching the user's page.
Then **apply that identity's palette and type to the user's page**: reuse its color roles and font
scale rather than inventing new ones. If the user has their own site, read it, then the reference,
then reconcile the two and apply the palette/type/layout tastefully with \`setStyle\`/\`setText\`.
Prefer \`describe\` over a \`screenshot\` for a text read of layout/content — reach for vision
(\`screenshot\`, \`describe\`'s \`scene\` mode) only to verify a visual change, not to survey structure
you could get from \`extractIdentity\`/\`describe\`/\`a11ySnapshot\` for free. **Check mobile and tablet,
not just desktop** — \`setDevice\` (or \`responsiveCapture\` for a side-by-side set) the reference and the
user's page at the same breakpoints and match how the reference's layout adapts, not only its desktop
look. When you \`recordEdit\` a change made under emulation, set \`breakpoint\` to the device. Don't just
imitate — call out what you improved and why.`;

const DEBUG_ADDENDUM = `**This turn is a debug task.** Start diagnostics immediately: \`diagnostics\`
(\`drain\` for buffered runtime/network signals, \`scan\` for a fresh a11y/layout pass) before you
touch anything. Then observe → hypothesize → reproduce (drive the page) → capture (screenshot /
console / network) → confirm → root-cause → fix. Navigate *with* the user, don't seize their tab.
Cover responsive breakage explicitly — \`setDevice\` to mobile and tablet, not only the current width,
and run \`checkResponsive\` there too; a bug that only reproduces on a phone is still a bug. Every
finding you report needs repro steps and evidence — a hunch is not a diagnosis.`;

/** Preferred tool-call order for a mode, surfaced to tests/callers as data (not an enforced
 *  filter — every tool stays available; this only informs the addendum's emphasis). */
const COPY_TOOL_EMPHASIS = [
  'browse',
  'extractIdentity',
  'describe',
  'query',
  'getStyles',
  'a11ySnapshot',
  'setStyle',
  'setText',
  'setDevice',
];
const DEBUG_TOOL_EMPHASIS = [
  'diagnostics',
  'a11ySnapshot',
  'getStyles',
  'screenshot',
  'query',
  'setDevice',
  'checkResponsive',
];

export interface ModeGuidance {
  /** Feeds `buildSystemPrompt({ addenda })`. ALWAYS EMPTY since #168 — injecting the mode
   *  addendum into the SYSTEM prompt made every mode flip rewrite the prompt-cache prefix
   *  (OpenAI-compatible caching is prefix-based), invalidating the cached system block +
   *  thread on the very turns that switch activity. Kept in the shape so callers composing
   *  `buildSystemPrompt({ addenda: modeGuidance(mode).addenda })` keep compiling and now get
   *  a byte-stable system prompt for free. */
  readonly addenda: SystemPromptOptions['addenda'];
  /** The tools this mode leans on first, in the order the agent should reach for them. */
  readonly toolEmphasis: readonly string[];
  /** The per-turn mode directive, for the MESSAGE TAIL: append it to the outgoing user
   *  message (a trailing paragraph after the user's text). Rides the conversation — which
   *  changes every turn anyway — so a mode flip costs nothing cache-wise. `undefined` for no
   *  mode: the base `MODES` section already covers both activities generically. */
  readonly turnAddendum?: string;
}

const NONE_GUIDANCE: ModeGuidance = { addenda: {}, toolEmphasis: [] };

/** The per-turn directive + tool emphasis for one turn's resolved mode. `undefined` (no mode
 *  inferred/chosen — a generic edit) returns no addendum: the base `MODES` section already
 *  covers both activities, so there's nothing to sharpen. */
export function modeGuidance(mode: Mode | undefined): ModeGuidance {
  switch (mode) {
    case 'copy':
      return { addenda: {}, toolEmphasis: COPY_TOOL_EMPHASIS, turnAddendum: COPY_ADDENDUM };
    case 'debug':
      return { addenda: {}, toolEmphasis: DEBUG_TOOL_EMPHASIS, turnAddendum: DEBUG_ADDENDUM };
    default:
      return NONE_GUIDANCE;
  }
}
