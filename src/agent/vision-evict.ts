// Stale-vision eviction — the STEP-AGE half of keeping screenshots affordable (#168 follow-up).
//
// THE GAP THIS CLOSES: `pruneInFlightImages` keeps the newest N image SETS, which bounds how many
// screenshots ride the transcript — but not for HOW LONG. A turn that captures once at step 1 and
// then edits for ten steps re-uploads that one capture on every remaining model call: the set-count
// window never fills, so nothing ages out. A real turn billed ~277k tokens across 3 steps this way.
// A screenshot is evidence for the step or two after it is taken; after that the model has already
// acted on it, and re-billing the pixels buys nothing a re-capture would not buy fresher.
//
// POLICY: a vision payload (image/file items in a tool result, or a generated assistant `file`
// part) whose step is older than the last {@link KEEP_RECENT_VISION_STEPS} completed steps is
// replaced with {@link STALE_VISION_STUB} text. The tool-call/tool-result structure — ids, names,
// inputs, surrounding text — survives verbatim, so the transcript stays coherent and still
// round-trips `modelMessageSchema`. The CURRENT step's and the immediately preceding step's vision
// results are never touched, so the capture → compare → correct loop keeps its evidence.
//
// PREFIX-CACHE POLICY, same as its siblings in `thread-compact.ts`: a payload is rewritten exactly
// ONCE — the step it ages past the window — and the rewrite is idempotent (a stubbed result has no
// media left, so later passes return it by reference). Below the window the input ARRAY comes back
// unchanged (same reference), so the common short turn allocates nothing and the cached prompt
// prefix moves only at a real aging event.
//
// USER-ATTACHED MEDIA IS EXEMPT, for the same reason `pruneInFlightImages` exempts it: a mockup off
// the user's desktop is irreplaceable input, not re-capturable output, and it is one-shot by design
// anyway (`src/shared/attachments.ts` — consumed by its turn, never persisted).
//
// This runs ONLY on the OUTGOING messages inside the loop's `prepareStep` hook (`agent/loop.ts`) —
// the same boundary `compactToWindow` intercepts. The persisted thread is never mutated here;
// `compactForThread` already strips images before anything is stored. Pure + chrome-free + no
// `any`; SW-only by usage.

import type { ChatMessage } from './session';
import { compactToolOutput, outputHasMedia } from './thread-compact';

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
type AssistantPart = Exclude<AssistantMessage['content'], string>[number];
type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;
type ToolPart = ToolMessage['content'][number];

/** What stands in for a vision payload evicted for step-age. Distinct wording from the set-count
 *  placeholder: there may be NO newer capture in the transcript at all — the honest advice is that
 *  the content was already acted on, and a fresh look costs one tool call. */
export const STALE_VISION_STUB =
  '[screenshot taken earlier — content acted on; re-run the tool if you need a fresh look]';

/** How many of the most recent completed steps keep their vision payloads intact. Two = the step
 *  being reacted to plus the one before it — exactly the before/after pair the self-correction
 *  loop compares, matching `KEEP_NEWEST_IMAGE_SETS`'s rationale on the count axis. */
export const KEEP_RECENT_VISION_STEPS = 2;

/**
 * Step-age eviction for the loop's `prepareStep` hook: replace every agent-generated vision payload
 * older than the last {@link KEEP_RECENT_VISION_STEPS} steps with {@link STALE_VISION_STUB} text,
 * leaving tool-call/result structure intact. A "step" is one assistant message — the SDK appends
 * exactly one per model call, so assistant-message count = completed-step count, and a tool message
 * belongs to the step of the assistant message that called it. Prior turns' assistant messages
 * count too, which is correct: staleness is measured from the END of the transcript, and prior
 * turns' images are already placeholders (`compactForThread`) so re-visiting them is a no-op.
 *
 * Returns the INPUT ARRAY UNCHANGED (same reference) when nothing is stale. Never touches user
 * messages. Pure; shares structure for untouched messages.
 */
export function evictStaleVision(
  messages: ChatMessage[],
  keepRecentSteps = KEEP_RECENT_VISION_STEPS,
): ChatMessage[] {
  const totalSteps = messages.reduce((n, m) => (m.role === 'assistant' ? n + 1 : n), 0);
  if (totalSteps <= keepRecentSteps) return messages;
  // Steps 1..staleCeiling are stale; steps above it are the protected recent window.
  const staleCeiling = totalSteps - keepRecentSteps;

  let changed = false;
  let step = 0;
  const out = messages.map((message) => {
    if (message.role === 'assistant') step += 1;
    // `step` is now the step this message belongs to (a tool message inherits the preceding
    // assistant message's step). User/system messages are exempt outright; `step === 0` is
    // anything before the first assistant message.
    if (message.role === 'user' || message.role === 'system') return message;
    if (step === 0 || step > staleCeiling) return message;
    const stripped = stripVision(message);
    if (stripped === message) return message;
    changed = true;
    return stripped;
  });
  return changed ? out : messages;
}

/** Strip vision payloads from one stale assistant/tool message, returning the SAME reference when
 *  it carries none — the identity that makes eviction idempotent and prefix-stable. */
function stripVision(message: ChatMessage): ChatMessage {
  if (message.role === 'tool') {
    let touched = false;
    const content = message.content.map((part) => {
      const next = stripToolPart(part);
      if (next !== part) touched = true;
      return next;
    });
    return touched ? { ...message, content } : message;
  }
  if (message.role === 'assistant' && typeof message.content !== 'string') {
    let touched = false;
    const content = message.content.map((part): AssistantPart => {
      if (part.type === 'file') {
        touched = true;
        return { type: 'text', text: STALE_VISION_STUB };
      }
      const next = stripToolPart(part);
      if (next !== part) touched = true;
      return next;
    });
    return touched ? { ...message, content } : message;
  }
  return message;
}

/** One part: a media-bearing tool result gets its images replaced (structure, ids and text kept —
 *  `compactToolOutput` swaps only the media items for the stub); anything else passes through. */
function stripToolPart<P extends ToolPart | AssistantPart>(part: P): P {
  if (part.type !== 'tool-result' || !outputHasMedia(part.output)) return part;
  return { ...part, output: compactToolOutput(part.output, STALE_VISION_STUB) };
}
