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

function compactUserPart(part: UserPart): UserPart {
  if (part.type === 'image' || part.type === 'file') {
    return { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER };
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
 *  JSON keeps its structure); every media item in a `content` output becomes placeholder text. */
function compactToolOutput(
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
 * {@link KEEP_NEWEST_IMAGE_SETS} image-bearing units (one tool-result part, or one user/assistant
 * message, per unit) intact; replace every image in OLDER units with
 * {@link IMAGE_PRUNED_PLACEHOLDER} text. Returns the INPUT ARRAY UNCHANGED (same reference) when
 * there is nothing to prune, and rewrites each aged-out image exactly once — see the module
 * header's prefix-cache policy. Pure; shares structure for untouched messages.
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
    if (message.role === 'user' || message.role === 'assistant') {
      if (typeof message.content !== 'string' && message.content.some(isMediaPart)) {
        units.push({ messageIndex, partIndex: null });
      }
      if (message.role === 'assistant' && typeof message.content !== 'string') {
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

function outputHasMedia(output: ToolOutput): boolean {
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
  if (message.role === 'user' && typeof message.content !== 'string') {
    return {
      ...message,
      content: message.content.map((part) =>
        isMediaPart(part) ? { type: 'text', text: IMAGE_PRUNED_PLACEHOLDER } : part,
      ),
    };
  }
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
export function compactSessionThread(messages: readonly ChatMessage[]): CompactSessionResult {
  const sizes = messages.map(approxSize);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= HIGH_WATER_APPROX_TOKENS * CHARS_PER_APPROX_TOKEN) {
    return { messages: [...messages], compacted: false };
  }

  const tailStart = tailStartIndex(messages, sizes);
  if (tailStart <= 0) return { messages: [...messages], compacted: false };

  const head = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);
  return { messages: [digestOf(head), ...tail], compacted: true };
}

const approxSize = (message: ChatMessage): number => JSON.stringify(message).length;

/** The index where the verbatim tail begins: walk back within the tail budget, then forward to
 *  the next turn boundary (a `user` message) so no tool message is orphaned from its tool call.
 *  Falls back to the LAST user message — the current turn is never digested. */
function tailStartIndex(messages: readonly ChatMessage[], sizes: readonly number[]): number {
  const budget = KEEP_TAIL_APPROX_TOKENS * CHARS_PER_APPROX_TOKEN;
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
