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

/** Best-effort mode from free text — the same heuristic a human skimming the instruction would
 *  use. Returns `undefined` when neither vocabulary shows up (a generic edit); the base prompt
 *  already covers that case, so no addendum is the correct answer, not a failure. */
export function inferMode(text: string): Mode | undefined {
  const lower = text.toLowerCase();
  if (DEBUG_KEYWORDS.some((kw) => lower.includes(kw))) return 'debug';
  if (COPY_KEYWORDS.some((kw) => lower.includes(kw))) return 'copy';
  return undefined;
}

/** An explicit `mode` always wins; only fall back to inference when the caller (or the composer)
 *  didn't set one. */
export function resolveMode(explicit: Mode | undefined, text: string): Mode | undefined {
  return explicit ?? inferMode(text);
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
you could get from \`extractIdentity\`/\`describe\`/\`a11ySnapshot\` for free. Don't just imitate — call
out what you improved and why.`;

const DEBUG_ADDENDUM = `**This turn is a debug task.** Start diagnostics immediately: \`diagnostics\`
(\`drain\` for buffered runtime/network signals, \`scan\` for a fresh a11y/layout pass) before you
touch anything. Then observe → hypothesize → reproduce (drive the page) → capture (screenshot /
console / network) → confirm → root-cause → fix. Navigate *with* the user, don't seize their tab.
Every finding you report needs repro steps and evidence — a hunch is not a diagnosis.`;

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
];
const DEBUG_TOOL_EMPHASIS = ['diagnostics', 'a11ySnapshot', 'getStyles', 'screenshot', 'query'];

export interface ModeGuidance {
  /** Feeds `buildSystemPrompt({ addenda })` — appended to the `modes` section. */
  readonly addenda: SystemPromptOptions['addenda'];
  /** The tools this mode leans on first, in the order the agent should reach for them. */
  readonly toolEmphasis: readonly string[];
}

const NONE_GUIDANCE: ModeGuidance = { addenda: {}, toolEmphasis: [] };

/** The prompt addendum + tool emphasis for one turn's resolved mode. `undefined` (no mode
 *  inferred/chosen — a generic edit) returns no addendum: the base `MODES` section already
 *  covers both activities, so there's nothing to sharpen. */
export function modeGuidance(mode: Mode | undefined): ModeGuidance {
  switch (mode) {
    case 'copy':
      return { addenda: { modes: [COPY_ADDENDUM] }, toolEmphasis: COPY_TOOL_EMPHASIS };
    case 'debug':
      return { addenda: { modes: [DEBUG_ADDENDUM] }, toolEmphasis: DEBUG_TOOL_EMPHASIS };
    default:
      return NONE_GUIDANCE;
  }
}
