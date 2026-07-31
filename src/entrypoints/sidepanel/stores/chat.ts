import { createSignal } from 'solid-js';
import type { Edit } from '@/shared/changeset';
import type { Mode, StableSelector, SwToPanel, TurnUsage } from '@/shared/messages';
import { OkResult } from '@/shared/messages';
import { request } from './bus';
import { multiSelectors } from './focus';
import { connectPort, subscribeToSw } from './sw-stream';

// Chat store (slice 11): assembles the conversation thread purely from the `SwToPanel` stream —
// `token`/`tool-call`/`edit-recorded`/`error`/`turn-done` — over `sw-stream.ts`. The SW is the only
// source of truth for what the agent did (CLAUDE.md "SolidJS + SRP"): this module never invents
// message content, it only folds the stream into a display-friendly shape and dispatches
// `user-message`/`session-stop` RPCs. Replaces the local-only `ChatPanel` TODO (`ChatPanel.tsx:21-22`).

export interface ToolCallEntry {
  tool: string;
  selector?: string;
  kind?: 'read' | 'act' | 'info';
  /** The SDK's tool-call id, when the SW carried one — how a `tool-result` finds its chip. */
  id?: string;
  /** The call's real outcome, folded in from `tool-result`. `undefined` means NOTHING has reported
   *  back yet: `tool-call` fires when the model REQUESTS a tool, so rendering it as success would
   *  fabricate one (see `components/chat/ToolCallList.tsx` `toolCallOutcome`). */
  ok?: boolean;
  /** The failure reason the tool reported, for the chip to show under a failed call. */
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: ToolCallEntry[];
  edits: Edit[];
  error?: string;
  /** True while this assistant turn is still receiving stream events (cleared by `turn-done`,
   *  an `error`, or a newer `send()` superseding it). Always `false` for a `role: 'user'` entry. */
  streaming: boolean;
}

/** Pure fold: apply one SW->panel message onto the thread. Unrelated message types are a no-op
 *  (identity). Exported for a mock-free unit test, mirroring `stores/mcp.ts`'s `reduceServers`. */
export function reduceChat(messages: ChatMessage[], msg: SwToPanel): ChatMessage[] {
  switch (msg.type) {
    case 'token':
      return foldIntoAssistant(messages, (m) => ({ ...m, text: m.text + msg.text }));
    case 'tool-call':
      return foldIntoAssistant(messages, (m) => ({
        ...m,
        toolCalls: [
          ...m.toolCalls,
          { tool: msg.tool, selector: msg.selector, kind: msg.kind, id: msg.id },
        ],
      }));
    case 'tool-result':
      return settleToolCall(messages, msg);
    case 'edit-recorded':
      return foldIntoAssistant(messages, (m) => ({ ...m, edits: [...m.edits, msg.edit] }));
    case 'error':
      // An error can arrive before any token/tool-call streamed (e.g. no provider configured) —
      // still worth a bubble — and it's always terminal for the turn it belongs to, so close out
      // streaming immediately rather than waiting on a `turn-done` that may never come (a rejected
      // `user-message` never reaches `runTurn`, so background.ts never emits one for it).
      return endStreaming(foldIntoAssistant(messages, (m) => ({ ...m, error: msg.message })));
    case 'turn-done':
      return endStreaming(messages);
    case 'session-state':
      // Two ways a turn ends without a `turn-done`: Stop (background.ts's `session-stop` handler
      // clears `turnAbort` itself, so the aborted turn never emits one) and an SW eviction
      // mid-turn (the woken worker reports `turnRunning: false` on connect — nothing will ever
      // finish that turn). Both leave the MESSAGE's own `streaming` flag set, so the bubble and
      // its last tool chip keep spinning as if the agent were still touching the page.
      // A plain `running` transition carrying no `turnRunning` says nothing about the turn — leave
      // the bubble alone.
      return msg.state !== 'running' || msg.turnRunning === false
        ? endStreaming(messages)
        : messages;
    default:
      return messages;
  }
}

/** Fold one `tool-result` onto the call it settles: by `id` when the SW carried one, else the
 *  newest still-unsettled call of the same name (the fallback the bus schema documents). Never
 *  opens a bubble — an outcome with no call to attach to is dropped rather than invented. */
function settleToolCall(
  messages: ChatMessage[],
  msg: Extract<SwToPanel, { type: 'tool-result' }>,
): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return messages;
  const idx = findToolCall(last.toolCalls, msg);
  const target = last.toolCalls[idx];
  if (!target) return messages;
  const toolCalls = last.toolCalls.slice();
  toolCalls[idx] = { ...target, ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) };
  return [...messages.slice(0, -1), { ...last, toolCalls }];
}

function findToolCall(
  calls: ToolCallEntry[],
  msg: Extract<SwToPanel, { type: 'tool-result' }>,
): number {
  if (msg.id) {
    const byId = calls.findIndex((c) => c.id === msg.id);
    if (byId !== -1) return byId;
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c?.tool === msg.tool && c.ok === undefined) return i;
  }
  return -1;
}

/** Zero-spend baseline for a fresh session's usage meter. */
export const ZERO_USAGE: TurnUsage = { steps: 0, tokens: 0 };

/** Pure fold for the session usage meter: `turn-done` carries the session's cumulative spend, so
 *  adopt it; every other message leaves the total unchanged. Exported for a mock-free unit test. */
export function nextUsage(prev: TurnUsage, msg: SwToPanel): TurnUsage {
  return msg.type === 'turn-done' ? msg.usage : prev;
}

/** Append `patch` onto the in-flight assistant message, or start a new one when the last message
 *  isn't a streaming assistant bubble (turn start, or the previous one already closed out). */
function foldIntoAssistant(
  messages: ChatMessage[],
  patch: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && last.streaming) {
    return [...messages.slice(0, -1), patch(last)];
  }
  return [...messages, patch(newAssistantMessage())];
}

/** Close out the in-flight assistant bubble, if any. Idempotent — a second `turn-done`/`error` is
 *  a no-op. */
function endStreaming(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && last.streaming) {
    return [...messages.slice(0, -1), { ...last, streaming: false }];
  }
  return messages;
}

function newAssistantMessage(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: '',
    toolCalls: [],
    edits: [],
    streaming: true,
  };
}

function newUserMessage(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    text,
    toolCalls: [],
    edits: [],
    streaming: false,
  };
}

const [messages, setMessages] = createSignal<ChatMessage[]>([]);
// Distinct from any one message's `streaming` flag: flips true the instant `send()` fires (before
// the first stream event lands) so the composer can disable itself immediately, and flips false on
// `turn-done`/`error`/a stopped or idle session — whichever closes out the turn first.
const [streaming, setStreaming] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
// Cumulative token/step spend for this session, folded from `turn-done`'s `usage` — the running
// usage meter (#25). Reset by `clearChat` on a fresh session.
const [usage, setUsage] = createSignal<TurnUsage>(ZERO_USAGE);

export { error, messages, streaming, usage };

let wired = false;

/** Open the SW port and fold incoming stream messages into the thread. Idempotent — safe to call
 *  on every ChatPanel mount. */
export function initChatStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    setMessages((prev) => reduceChat(prev, msg));
    setUsage((prev) => nextUsage(prev, msg));
    if (msg.type === 'turn-done' || msg.type === 'error') {
      setStreaming(false);
    } else if (
      msg.type === 'session-state' &&
      (msg.state !== 'running' || msg.turnRunning === false)
    ) {
      // Stop (or a session that never started, or a worker woken after dying mid-turn) always ends
      // any in-flight turn — belt-and-braces alongside `turn-done` for the abort path, where
      // background.ts's `session-stop` handler clears `turnAbort` itself and so the aborted turn's
      // own `turn-done` never fires. `reduceChat` closes the bubble's own flag on the same signal.
      setStreaming(false);
    }
  });
}

/** Reset the thread (e.g. Start on a fresh session). Local-only — the SW keeps its own resumable
 *  thread (`src/agent/session.ts`); this just clears the panel's display. */
export function clearChat(): void {
  setMessages([]);
  setStreaming(false);
  setError(null);
  setUsage(ZERO_USAGE);
}

/** Send a user instruction: appends it locally, closes out any prior in-flight bubble (the SW
 *  supersedes the old turn — see background.ts's `user-message` handler), and dispatches. Never
 *  throws — a dispatch failure surfaces via `error()` and clears `streaming`.
 *
 *  `selector` is the PICKED ELEMENT the composer's context chip is showing — the referent of
 *  "this" (#165 S6). Before it was carried, the picker resolved a target, the chip claimed an
 *  attachment, and the turn reached the SW as text alone: "make this 20% bigger" on a page with
 *  four CTAs restyled whichever one the model guessed. The shift-multi-select set rides along the
 *  same way, read straight off the focus store (the composer passes one pin, not the set). */
export async function send(text: string, mode?: Mode, selector?: StableSelector): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  setError(null);
  setMessages((prev) => [...endStreaming(prev), newUserMessage(trimmed)]);
  setStreaming(true);
  const multi = multiSelectors();
  try {
    await request(
      {
        type: 'user-message',
        text: trimmed,
        mode,
        selector,
        // Omitted when empty: an empty array is the "user cleared it" signal on the way IN, and
        // grounding a turn on nothing is not the same message as not grounding it at all.
        selectors: multi.length > 0 ? multi : undefined,
      },
      OkResult,
    );
  } catch (e) {
    setStreaming(false);
    setError(errMsg(e));
  }
}

/** Abort the in-flight turn (Stop button in the composer) without ending the session — mirrors
 *  `stores/session.ts`'s `stopSession`, kept local to this store so the composer doesn't need a
 *  second store import for one button. */
export async function stopTurn(): Promise<void> {
  try {
    await request({ type: 'session-stop' }, OkResult);
  } catch (e) {
    setError(errMsg(e));
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
