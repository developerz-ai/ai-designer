// Thread compaction — the pure size/shape policies that keep the agent's conversation memory
// (#168) affordable without losing what matters: WHICH tools ran, on WHAT, and what they
// RETURNED. Three consumers, three exports:
//
//   • `compactForThread` — before persisting a turn's `responseMessages` to the session thread:
//     tool-call/tool-result structure survives verbatim; image payloads become short text
//     placeholders; oversized text tool outputs are truncated with a marker. The result still
//     round-trips `modelMessageSchema` (pinned by unit test), so `session.ts` can validate it
//     on rehydrate.
//   • `pruneInFlightImages` — the loop's `prepareStep` hook: within one turn, keep only the
//     newest N screenshot sets in the in-flight transcript. PREFIX-CACHE POLICY: an image is
//     replaced exactly ONCE — when a newer capture pushes it out of the keep-window — and the
//     replacement then persists unchanged (the pruned transcript carries forward via the SDK's
//     `prepareStep` messages override). OpenAI-compatible prompt caching is prefix-based, so a
//     per-step rewrite of history would invalidate the whole cache every step; a single aging
//     event invalidates once and is then stable.
//   • `compactSessionThread` — the long-session high-water mark: a persisted thread past
//     ~`HIGH_WATER_APPROX_TOKENS` gets its OLDEST turns folded into one deterministic digest
//     message while the recent tail stays verbatim. Fires rarely (high-water, not per turn) so
//     the persisted thread stays append-only between compaction events — same prefix-cache
//     rationale as above, applied across turns.
//
// Pure + chrome-free + no `any`: structural transforms over `ModelMessage` (via the exported
// `modelMessageSchema` inference), unit-testable with fixtures. SW-only by usage.

import type { ChatMessage } from './session';

// --- part-type views (derived, so they can never drift from the SDK schema) -----------------

type UserMessage = Extract<ChatMessage, { role: 'user' }>;
type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;
type UserPart = Exclude<UserMessage['content'], string>[number];
type AssistantPart = Exclude<AssistantMessage['content'], string>[number];
type ToolPart = ToolMessage['content'][number];
type ToolResultPart = Extract<ToolPart, { type: 'tool-result' }>;
type ToolOutput = ToolResultPart['output'];
type ToolOutputContentItem = Extract<ToolOutput, { type: 'content' }>['value'][number];

/** What stands in for a screenshot/file payload stripped from the PERSISTED thread. Tells the
 *  model the visual existed and how to get a fresh one, instead of leaving a silent gap. */
export const IMAGE_OMITTED_PLACEHOLDER =
  '[screenshot omitted from saved thread — re-capture if you need current visuals]';

/** What stands in for an older screenshot pruned from the IN-FLIGHT transcript (within-turn).
 *  Distinct wording: newer captures are still present later in the same conversation. */
export const IMAGE_PRUNED_PLACEHOLDER =
  '[older screenshot pruned to save context — newer captures follow; re-capture if you need this view again]';

/** What stands in for a USER-ATTACHED image (a mockup, a reference) stripped from the PERSISTED
 *  thread. Deliberately different advice from {@link IMAGE_OMITTED_PLACEHOLDER}: "re-capture" is
 *  impossible for a file on the user's desktop, and telling the model to try produces a screenshot
 *  of the live page mistaken for the reference. The surviving text part still names the file and
 *  its dimensions (`agent/attachments.ts` `attachmentContextLine`), so the reference is described
 *  even once its pixels are gone. */
export const USER_MEDIA_OMITTED_PLACEHOLDER =
  '[reference image the user attached in an earlier turn — its pixels are not kept in the saved ' +
  'thread, only the description above. You cannot re-capture it; ask the user to re-attach it if ' +
  'you need to look again]';

/** Cap for a single text tool output persisted to the thread. Matches the history store's
 *  string bound in spirit: big reads are re-runnable, so persisting more buys nothing. */
export const TOOL_TEXT_CAP = 4_000;

const truncate = (text: string, cap = TOOL_TEXT_CAP): string =>
  text.length > cap ? `${text.slice(0, cap)}… [truncated ${text.length - cap} chars]` : text;

const textItem = (text: string): ToolOutputContentItem => ({ type: 'text', text });

// --- compactForThread ------------------------------------------------------------------------

/**
 * Compact one turn's model messages for persistence: assistant tool-call parts and tool-result
 * structure (ids, names, inputs) stay intact; image/file payloads become {@link
 * IMAGE_OMITTED_PLACEHOLDER} text; oversized text outputs are truncated with a marker; reasoning
 * parts (never re-sendable across turns, pure weight) are dropped. Pure — returns new messages,
 * never mutates the input. Output round-trips `modelMessageSchema`.
 */
export function compactForThread(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const compacted = compactMessage(message);
    if (compacted) out.push(compacted);
  }
  return out;
}

function compactMessage(message: ChatMessage): ChatMessage | null {
  switch (message.role) {
    case 'system':
      return message;
    case 'user':
      return typeof message.content === 'string'
        ? message
        : { ...message, content: message.content.map(compactUserPart) };
    case 'assistant': {
      if (typeof message.content === 'string') return message;
      const parts = message.content
        .filter((part) => part.type !== 'reasoning' && part.type !== 'reasoning-file')
        .map(compactAssistantPart);
      // An assistant message that was ONLY reasoning has nothing left to say — drop it whole.
      return parts.length > 0 ? { ...message, content: parts } : null;
    }
    case 'tool':
      return { ...message, content: message.content.map(compactToolPart) };
    default:
      return message;
  }
}

/** Media in a USER message is always something the user handed over (the loop's own captures come
 *  back as tool results, and the one-shot report/vision calls in `report.ts`/`vision.ts` build
 *  their own message arrays and never reach this thread) — so it gets the placeholder that doesn't
 *  tell the model to re-capture something it can't. */
function compactUserPart(part: UserPart): UserPart {
  if (part.type === 'image' || part.type === 'file') {
    return { type: 'text', text: USER_MEDIA_OMITTED_PLACEHOLDER };
  }
  return part;
}

function compactAssistantPart(part: AssistantPart): AssistantPart {
  if (part.type === 'file') return { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER };
  if (part.type === 'tool-result') return compactToolResult(part);
  return part;
}

function compactToolPart(part: ToolPart): ToolPart {
  return part.type === 'tool-result' ? compactToolResult(part) : part;
}

function compactToolResult(part: ToolResultPart): ToolResultPart {
  return { ...part, output: compactToolOutput(part.output) };
}

/** Shrink one tool output: text truncated; JSON stringified+truncated only when oversized (small
 *  JSON keeps its structure); every media item in a `content` output becomes placeholder text.
 *  Exported for `vision-evict.ts`, which applies the same replacement with its own stub — one
 *  media-item taxonomy, not two that drift. */
export function compactToolOutput(
  output: ToolOutput,
  placeholder = IMAGE_OMITTED_PLACEHOLDER,
): ToolOutput {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { ...output, value: truncate(output.value) };
    case 'json':
    case 'error-json': {
      const raw = JSON.stringify(output.value);
      if (raw !== undefined && raw.length > TOOL_TEXT_CAP) {
        return { type: output.type === 'json' ? 'text' : 'error-text', value: truncate(raw) };
      }
      return output;
    }
    case 'content':
      return {
        ...output,
        value: output.value.map((item) => compactContentItem(item, placeholder)),
      };
    default:
      return output;
  }
}

/** Text stays (truncated), `custom` stays (no payload); every other item kind — `file` and the
 *  deprecated `file-*`/`image-*` variants — carries media bytes/urls and becomes the placeholder. */
function compactContentItem(
  item: ToolOutputContentItem,
  placeholder: string,
): ToolOutputContentItem {
  if (item.type === 'text') return { ...item, text: truncate(item.text) };
  if (item.type === 'custom') return item;
  return textItem(placeholder);
}

// --- pruneInFlightImages ---------------------------------------------------------------------

/** How many of the newest screenshot SETS the in-flight transcript keeps (a multi-breakpoint
 *  `responsiveCapture` result counts as ONE set — splitting it would leave the model comparing
 *  half a sweep). Two sets = before/after, the pair the self-correction loop actually uses. */
export const KEEP_NEWEST_IMAGE_SETS = 2;

/**
 * Within-turn transcript pruning for the loop's `prepareStep` hook: keep the newest
 * {@link KEEP_NEWEST_IMAGE_SETS} AGENT-GENERATED image-bearing units (one tool-result part, or one
 * assistant message, per unit) intact; replace every image in OLDER units with
 * {@link IMAGE_PRUNED_PLACEHOLDER} text. Returns the INPUT ARRAY UNCHANGED (same reference) when
 * there is nothing to prune, and rewrites each aged-out image exactly once — see the module
 * header's prefix-cache policy. Media the USER attached is exempt entirely and never counts toward
 * the window — it is input the agent cannot re-acquire. Pure; shares structure for untouched
 * messages.
 */
export function pruneInFlightImages(
  messages: ChatMessage[],
  keepNewest = KEEP_NEWEST_IMAGE_SETS,
): ChatMessage[] {
  const units = imageUnits(messages);
  if (units.length <= keepNewest) return messages;
  const strip = units.slice(0, units.length - keepNewest);

  const byMessage = new Map<number, Set<number | null>>();
  for (const unit of strip) {
    const parts = byMessage.get(unit.messageIndex) ?? new Set<number | null>();
    parts.add(unit.partIndex);
    byMessage.set(unit.messageIndex, parts);
  }

  return messages.map((message, index) => {
    const parts = byMessage.get(index);
    return parts ? stripImagesFromMessage(message, parts) : message;
  });
}

/** One image-bearing unit: a tool-result part with media in its content output (`partIndex`
 *  set), or a user/assistant message with image/file parts (`partIndex` null = whole message). */
interface ImageUnit {
  readonly messageIndex: number;
  readonly partIndex: number | null;
}

function imageUnits(messages: readonly ChatMessage[]): ImageUnit[] {
  const units: ImageUnit[] = [];
  messages.forEach((message, messageIndex) => {
    // USER-ATTACHED MEDIA IS NEVER A PRUNABLE UNIT. Agent-generated media is prunable because it is
    // RE-CAPTURABLE — a screenshot aged out of the transcript can be taken again for the cost of one
    // tool call. A mockup the user attached is irreplaceable INPUT: it lives on their desktop, the
    // agent has no tool that can fetch it back, and `IMAGE_PRUNED_PLACEHOLDER` telling it to
    // "re-capture this view" points it at the live page — the very thing it was asked to CHANGE. On
    // any iterating turn (screenshot → edit → screenshot) two of the agent's own captures used to
    // evict the reference it was designing towards, after which it invents. So: skip user messages
    // entirely, and never mind the count. Every media part in a user message is user-attached —
    // `runTurn` only ever adds assistant/tool messages to the transcript, and the one-shot vision
    // and report calls (`vision.ts`, `report.ts:141`) build their own message arrays that never
    // pass through `prepareStep`.
    //
    // Cost of the exemption, accepted deliberately: at most `MAX_IMAGE_ATTACHMENTS` (6) images ride
    // every step of that one turn. It cannot run away — the schema caps both the count and the
    // bytes per image, the user chose them, and the loop's own token budget (`agent/budget.ts`)
    // already stops a turn whose steps have grown too expensive.
    if (message.role === 'user') return;
    if (message.role === 'assistant') {
      if (typeof message.content !== 'string' && message.content.some(isMediaPart)) {
        units.push({ messageIndex, partIndex: null });
      }
      if (typeof message.content !== 'string') {
        message.content.forEach((part, partIndex) => {
          if (part.type === 'tool-result' && outputHasMedia(part.output)) {
            units.push({ messageIndex, partIndex });
          }
        });
      }
      return;
    }
    if (message.role === 'tool') {
      message.content.forEach((part, partIndex) => {
        if (part.type === 'tool-result' && outputHasMedia(part.output)) {
          units.push({ messageIndex, partIndex });
        }
      });
    }
  });
  return units;
}

function isMediaPart(part: UserPart | AssistantPart): boolean {
  return part.type === 'image' || part.type === 'file';
}

/** Whether a tool output carries any media item. Exported for `vision-evict.ts` (see
 *  {@link compactToolOutput}). */
export function outputHasMedia(output: ToolOutput): boolean {
  return (
    output.type === 'content' &&
    output.value.some((item) => item.type !== 'text' && item.type !== 'custom')
  );
}

function stripImagesFromMessage(
  message: ChatMessage,
  partIndexes: ReadonlySet<number | null>,
): ChatMessage {
  if (message.role === 'tool') {
    return {
      ...message,
      content: message.content.map((part, index) =>
        partIndexes.has(index) && part.type === 'tool-result'
          ? { ...part, output: compactToolOutput(part.output, IMAGE_PRUNED_PLACEHOLDER) }
          : part,
      ),
    };
  }
  // No `user` branch: `imageUnits` never emits a user message index (see the exemption there), so
  // a user message can never reach this function. Adding one back would silently re-introduce the
  // defect it fixes.
  if (message.role === 'assistant' && typeof message.content !== 'string') {
    return {
      ...message,
      content: message.content.map((part, index) => {
        if (partIndexes.has(null) && part.type === 'file') {
          return { type: 'text', text: IMAGE_PRUNED_PLACEHOLDER };
        }
        if (partIndexes.has(index) && part.type === 'tool-result') {
          return { ...part, output: compactToolOutput(part.output, IMAGE_PRUNED_PLACEHOLDER) };
        }
        return part;
      }),
    };
  }
  return message;
}

// --- capInFlightResults (within-turn text ceiling) --------------------------------------------

/**
 * Per-result character ceiling for the IN-FLIGHT transcript.
 *
 * DERIVATION (2026-08-14, measured — not folklore). The defect: {@link TOOL_TEXT_CAP} bounds a
 * tool result only when the turn is PERSISTED, i.e. exactly one moment too late. Nothing bounded a
 * result while the turn was still running, and every step re-sends the whole transcript, so one
 * oversized read is billed once per remaining step — cost quadratic in result size, not linear.
 *
 * Measured on a Hacker-News-shaped DOM (750 elements, `src/dom/read.ts`): `a11ySnapshot` returns
 * ~22.4k chars (~5.6k tokens) and has NO aggregate ceiling — only depth 12 × 60 children per node
 * (`read.ts:181-182`). `query` is capped at 25 matches (~5.5k chars), `describe` at 2k chars,
 * `getStyles` runs ~440 chars. So the ceiling has to sit above the honestly-bounded reads and below
 * the unbounded one: 8k chars ≈ 2k tokens passes `query`, `describe`, `getStyles` and
 * `extractIdentity` UNTOUCHED, and clips only the genuinely unbounded outputs.
 *
 * Sizing rule (`context-budget.md`: observed healthy maximum × a comfortable multiple): the largest
 * honestly-bounded result observed is `query` at ~5.5k chars; 5.5k × 1.5 ≈ 8k. Re-measure before
 * changing this. It is NOT a work budget — nothing is refused, and the marker tells the model how
 * to get the rest.
 */
export const IN_FLIGHT_TEXT_CAP = 8_000;

/** Appended to a clipped in-flight result. It must be ACTIONABLE, not merely honest: a bare
 *  "truncated" invites the model to reason about what it cannot see (the confabulation failure
 *  `query`'s and `describe`'s own markers exist for), so it names the two moves that actually get
 *  the rest. */
function inFlightMarker(dropped: number): string {
  return (
    `… [TRUNCATED: ${dropped} more characters not shown. You received a PREFIX, not the whole ` +
    'result — do not describe what is past the cut. To see the rest, re-read a NARROWER target ' +
    '(a selector scoped to one region) or page through it.]'
  );
}

/** Room reserved for {@link inFlightMarker} inside the cap, so a CLIPPED value comes back at or
 *  under the cap and the next pass leaves it alone.
 *
 *  This is what makes the clip IDEMPOTENT, and idempotence is the whole prefix-cache property:
 *  without the reserve the marker pushed the result back over the cap, every step re-clipped it,
 *  and the prompt prefix was rewritten on every single step — turning a cache-preserving measure
 *  into the most expensive possible cache-buster. Caught by
 *  `test/unit/thread-compact.test.ts`'s idempotence test, which is why that test exists. 320 is
 *  comfortably above the marker's longest form (~250 chars plus a 10-digit count). */
const MARKER_RESERVE = 320;

/**
 * Bound every oversized TEXT tool output in the in-flight transcript, for the loop's `prepareStep`
 * hook — the text-side sibling of {@link pruneInFlightImages}, and the reason a single unbounded
 * read can no longer be re-billed on every remaining step of the turn.
 *
 * PREFIX-CACHE POLICY, identical to `pruneInFlightImages`: a result is rewritten exactly ONCE (the
 * step it first appears), and the rewrite is idempotent — a clipped value is already under the cap,
 * so later steps return it untouched. Returns the INPUT ARRAY UNCHANGED (same reference) when
 * nothing is over the cap, so the common turn allocates nothing and the cached prefix is stable.
 *
 * Images are NOT touched here (that is `pruneInFlightImages`'s job) and user-attached media is
 * never affected. Pure; shares structure for untouched messages.
 */
export function capInFlightResults(
  messages: ChatMessage[],
  cap = IN_FLIGHT_TEXT_CAP,
): ChatMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== 'tool' && message.role !== 'assistant') return message;
    if (typeof message.content === 'string') return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const output = capToolOutput(part.output, cap);
      if (output === part.output) return part;
      messageChanged = true;
      return { ...part, output };
    });
    if (!messageChanged) return message;
    changed = true;
    // The `as` is the narrowing TS cannot do across the role union: `content` was mapped from
    // this message's OWN parts, so its element type is exactly the message's part type.
    return { ...message, content } as ChatMessage;
  });
  return changed ? out : messages;
}

/** Clip one tool output's text, returning the SAME object when nothing was over the cap (the
 *  identity that keeps the prompt prefix stable). JSON outputs are left structurally intact unless
 *  oversized, matching `compactToolOutput`'s policy. */
function capToolOutput(output: ToolOutput, cap: number): ToolOutput {
  const keep = Math.max(0, cap - MARKER_RESERVE);
  const clip = (text: string): string =>
    text.length > cap ? `${text.slice(0, keep)}${inFlightMarker(text.length - keep)}` : text;

  switch (output.type) {
    case 'text':
    case 'error-text': {
      const value = clip(output.value);
      return value === output.value ? output : { ...output, value };
    }
    case 'json':
    case 'error-json': {
      const raw = JSON.stringify(output.value);
      if (raw === undefined || raw.length <= cap) return output;
      // Oversized JSON becomes clipped TEXT — the same downgrade `compactToolOutput` makes on
      // persist. Keeping it as JSON would mean emitting invalid JSON with a marker glued on.
      return { type: output.type === 'json' ? 'text' : 'error-text', value: clip(raw) };
    }
    case 'content': {
      let itemChanged = false;
      const value = output.value.map((item) => {
        if (item.type !== 'text') return item;
        const text = clip(item.text);
        if (text === item.text) return item;
        itemChanged = true;
        return { ...item, text };
      });
      return itemChanged ? { ...output, value } : output;
    }
    default:
      return output;
  }
}

// --- compactSessionThread (long-session high-water mark) -------------------------------------

/** ~Token budget the persisted thread may reach before the oldest turns are digested. Approx
 *  tokens = serialized chars / 4 (the OpenAI-family rule of thumb; images are already
 *  placeholders by the time messages land here, so chars track prompt weight well). 24k approx
 *  tokens ≈ 96 KB of thread — an eighth of the default 200k per-turn token budget spent on pure
 *  history is where re-sending every turn stops earning its cost. */
export const HIGH_WATER_APPROX_TOKENS = 24_000;

/** How much recent thread survives verbatim after a compaction, largest suffix of WHOLE turns
 *  under this budget (never less than the most recent turn, whatever its size). */
export const KEEP_TAIL_APPROX_TOKENS = 8_000;

const CHARS_PER_APPROX_TOKEN = 4;

/** Digest messages are marked so a later compaction folds them instead of stacking markers,
 *  and so tests/UI can recognize them. */
export const SESSION_MEMORY_MARKER = '[Session memory]';

const DIGEST_CAP_CHARS = 2_000;
const ASK_SNIPPET_CHARS = 80;

export interface CompactSessionResult {
  readonly messages: ChatMessage[];
  /** True when a compaction actually fired (the caller may want to log/telemeter it). */
  readonly compacted: boolean;
}

/**
 * High-water compaction for the PERSISTED session thread. Under
 * {@link HIGH_WATER_APPROX_TOKENS}: returns the input untouched (append-only fast path — the
 * common case, so cross-turn prompt-cache prefixes stay stable). Over it: the oldest whole turns
 * are replaced by ONE deterministic digest user message ({@link SESSION_MEMORY_MARKER}-prefixed:
 * what the user asked, which tools ran and how often), and the newest turns — always at least the
 * most recent one — stay verbatim. No model call (v1 is a structural digest; a model-written
 * summary would cost a turn's latency+tokens inside `appendMessages`, the wrong place to spend
 * either). Deterministic: same input, same output. Output round-trips `modelMessageSchema`.
 */
export function compactSessionThread(
  messages: readonly ChatMessage[],
  // Optional so `session.ts`'s existing call site needs no change, and so a caller that KNOWS the
  // model's context window can drive this proportionally instead of by a fixed character count.
  highWaterApproxTokens = HIGH_WATER_APPROX_TOKENS,
  keepTailApproxTokens = KEEP_TAIL_APPROX_TOKENS,
): CompactSessionResult {
  const sizes = messages.map(approxSize);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= highWaterApproxTokens * CHARS_PER_APPROX_TOKEN) {
    return { messages: [...messages], compacted: false };
  }

  const tailStart = tailStartIndex(messages, sizes, keepTailApproxTokens);
  if (tailStart <= 0) return { messages: [...messages], compacted: false };

  const head = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);
  // The head is folded to a digest, but anything in it the agent CANNOT REACQUIRE is spliced back
  // verbatim — see `preservedFromHead`. Source order is preserved, so the result is deterministic.
  return { messages: [digestOf(head), ...preservedFromHead(head), ...tail], compacted: true };
}

/**
 * Messages from the compacted head that survive the digest verbatim.
 *
 * A digest is prose: it records THAT the user attached a mockup, not the mockup. For a screenshot
 * that is fine — the agent can take another. For USER-ATTACHED reference material it is not: those
 * pixels came off the user's desktop and no tool can get them back, which is exactly why
 * `pruneInFlightImages` already exempts user media. Compaction has to honour the same asymmetry, or
 * the long overhaul turn that most needs compaction is also the one that silently loses the design
 * it is working towards.
 *
 * Only the media-bearing user messages are kept, not their whole turns — the surrounding prose is
 * already represented in the digest.
 */
function preservedFromHead(head: readonly ChatMessage[]): ChatMessage[] {
  return head.filter(
    (message) =>
      message.role === 'user' &&
      typeof message.content !== 'string' &&
      message.content.some(isMediaPart),
  );
}

// --- compactToWindow (proportional, context-window aware) --------------------------------------

/**
 * Fraction of the model's context window at which the in-flight transcript is compacted.
 *
 * DERIVATION: this is a HEADROOM number, not a utilisation target. What has to fit above it is one
 * more full step: the standing context (measured 11,764 tokens — system prompt 4,276 + 42 tool
 * schemas 7,488), plus the largest single result the agent can still produce
 * (`IN_FLIGHT_TEXT_CAP` = 8k chars ≈ 2k tokens, or a screenshot at roughly 1.5-5k vision tokens),
 * plus the model's own output. That is ~20k tokens of headroom, which is 16% of the 128k fallback
 * window and less on a larger one — so 30% headroom clears it comfortably at every window size we
 * are likely to see, and the margin grows in absolute terms exactly where results are biggest.
 *
 * Erring low is cheap (a digest fires slightly early); erring high is not (a hard provider error
 * mid-turn, losing the turn). Re-measure the standing context before moving it.
 */
export const COMPACT_AT_WINDOW_FRACTION = 0.7;

/**
 * Approximate standing per-step context — system prompt + tool schemas — that the transcript shares
 * the window with. MEASURED 2026-08-14: 17,104 chars of system prompt + 29,950 chars across 42 tool
 * schemas = 47,054 chars ≈ 11,764 tokens. Re-measure when the prompt or the tool surface changes;
 * a drifted number here is worse than none, because it still looks deliberate.
 */
export const STANDING_CONTEXT_APPROX_TOKENS = 11_764;

/** How much of the post-compaction budget the verbatim tail may occupy. The rest is headroom for
 *  the digest and the steps that follow. Half keeps a substantial working set — the instruction and
 *  the results being acted on — while guaranteeing the compaction actually reclaims something. */
const TAIL_FRACTION_OF_BUDGET = 0.5;

/** The transcript's guaranteed floor of the compaction budget, whatever the standing-context
 *  estimate claims it needs — see the derivation at the `transcriptBudget` computation below. */
const MIN_TRANSCRIPT_FRACTION = 0.5;

/** Approximate prompt tokens for a transcript, including the standing context it shares the window
 *  with. Same chars/4 approximation the rest of this module uses. */
export function approxPromptTokens(
  messages: readonly ChatMessage[],
  standing = STANDING_CONTEXT_APPROX_TOKENS,
): number {
  const chars = messages.reduce((sum, message) => sum + approxSize(message), 0);
  return Math.round(chars / CHARS_PER_APPROX_TOKEN) + standing;
}

/**
 * Compact the IN-FLIGHT transcript when it approaches the model's real context window — the
 * capacity-shaped guard `compactSessionThread`'s fixed character high-water could never be, because
 * a 32k model and a 1M model were held to the same number.
 *
 * Returns the INPUT ARRAY UNCHANGED (same reference) below the threshold, which is the overwhelming
 * common case. Above it, the oldest whole turns fold into one deterministic digest (the SAME
 * mechanism `compactSessionThread` uses — one strategy, not two), user-attached reference material
 * is spliced back verbatim, and the recent tail stays untouched.
 *
 * PROMPT-CACHE TRADE, stated so it is a decision and not a later surprise: compaction rewrites the
 * head of the prompt, so it invalidates the cached prefix that `pruneInFlightImages`,
 * `capInFlightResults` and the byte-stable system prompt all work to preserve. That is the right
 * trade at 70% full — the alternative is not a cheaper turn, it is a hard provider error that ends
 * the turn — but it is a REAL cost, and it is why this fires on a high-water mark rather than
 * per-step, and why the two cheaper measures run first. Expect a cache-miss step immediately after
 * a compaction; a run of them means the threshold is wrong, not that caching is broken.
 *
 * Deterministic and idempotent: once a pass brings the transcript under the threshold, further
 * passes return it unchanged.
 */
export function compactToWindow(
  messages: ChatMessage[],
  contextWindow: number,
  standing = STANDING_CONTEXT_APPROX_TOKENS,
): ChatMessage[] {
  const budget = Math.floor(contextWindow * COMPACT_AT_WINDOW_FRACTION);
  if (budget <= 0) return messages;
  if (approxPromptTokens(messages, standing) <= budget) return messages;

  // Both thresholds are expressed to `compactSessionThread` in ITS vocabulary (approx tokens of
  // transcript, standing context excluded) so there is one compaction implementation, not two.
  //
  // Never let the standing-context ESTIMATE eat the whole window: at 8k it exceeds the estimate
  // outright, `transcriptBudget` went to 0, and `tailStartIndex` fell through to "the last user
  // message" on EVERY step — the turn's own tool results discarded each step, so the agent re-read
  // the page forever. Half the budget is a floor, not a target: it only binds when the estimate
  // says there is no room at all.
  const transcriptBudget = Math.max(
    Math.floor(budget * MIN_TRANSCRIPT_FRACTION),
    budget - standing,
  );
  const { messages: compacted, compacted: didCompact } = compactSessionThread(
    messages,
    transcriptBudget,
    Math.floor(transcriptBudget * TAIL_FRACTION_OF_BUDGET),
  );
  return didCompact ? compacted : messages;
}

const approxSize = (message: ChatMessage): number => JSON.stringify(message).length;

/** The index where the verbatim tail begins: walk back within the tail budget, then forward to
 *  the next turn boundary (a `user` message) so no tool message is orphaned from its tool call.
 *  Falls back to the LAST user message — the current turn is never digested. */
function tailStartIndex(
  messages: readonly ChatMessage[],
  sizes: readonly number[],
  keepTailApproxTokens = KEEP_TAIL_APPROX_TOKENS,
): number {
  const budget = keepTailApproxTokens * CHARS_PER_APPROX_TOKEN;
  let spent = 0;
  let candidate = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = sizes[i] ?? 0;
    if (spent + size > budget) break;
    spent += size;
    candidate = i;
  }
  for (let i = candidate; i < messages.length; i++) {
    const msg = messages[i];
    if (msg !== undefined && isPlainUserMessage(msg)) return i;
  }
  // No user message at or after the budget boundary — fall back to the last user message so the
  // in-progress turn always survives verbatim.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && isPlainUserMessage(msg)) return i;
  }
  return 0;
}

function isPlainUserMessage(message: ChatMessage): boolean {
  return message.role === 'user' && !textOf(message).startsWith(SESSION_MEMORY_MARKER);
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join(' ');
}

/** The deterministic structural digest of the compacted head: prior digests folded in, each user
 *  ask as a snippet, tool usage tallied by name. Capped at {@link DIGEST_CAP_CHARS}. */
function digestOf(head: readonly ChatMessage[]): ChatMessage {
  const lines: string[] = [];
  const toolCounts = new Map<string, number>();

  for (const message of head) {
    if (message.role === 'user') {
      const text = textOf(message);
      if (text.startsWith(SESSION_MEMORY_MARKER)) {
        // Fold a previous digest: keep its bullet lines, not its header, so markers never stack.
        for (const line of text.split('\n').slice(1)) {
          if (line.trim().length > 0) lines.push(line);
        }
      } else if (text.length > 0) {
        const snippet = text.slice(0, ASK_SNIPPET_CHARS);
        lines.push(`- user asked: "${snippet}${text.length > ASK_SNIPPET_CHARS ? '…' : ''}"`);
      }
      continue;
    }
    if (message.role === 'assistant' && typeof message.content !== 'string') {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          toolCounts.set(part.toolName, (toolCounts.get(part.toolName) ?? 0) + 1);
        }
      }
    }
  }

  if (toolCounts.size > 0) {
    const tally = [...toolCounts.entries()].map(([name, count]) => `${name}×${count}`).join(', ');
    lines.push(`- tools run in those turns: ${tally}`);
  }

  const body = truncate(lines.join('\n'), DIGEST_CAP_CHARS);
  return {
    role: 'user',
    content:
      `${SESSION_MEMORY_MARKER} Older turns were compacted to stay within context limits. ` +
      `What happened earlier in this session:\n${body}\n` +
      'Their live edits are still applied on the page and recorded in the changeset. ' +
      'Re-read the page if you need details this summary dropped.',
  };
}
