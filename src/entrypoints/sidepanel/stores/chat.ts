import { createSignal } from 'solid-js';
import type { Edit } from '@/shared/changeset';
import type { Mode, SwToPanel, TurnUsage } from '@/shared/messages';
import { OkResult } from '@/shared/messages';
import { request } from './bus';
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
        toolCalls: [...m.toolCalls, { tool: msg.tool, selector: msg.selector, kind: msg.kind }],
      }));
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
    default:
      return messages;
  }
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
    } else if (msg.type === 'session-state' && msg.state !== 'running') {
      // Stop (or a session that never started) always ends any in-flight turn — belt-and-braces
      // alongside `turn-done` for the abort path, where background.ts's `session-stop` handler
      // clears `turnAbort` itself and so the aborted turn's own `turn-done` never fires.
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
 *  throws — a dispatch failure surfaces via `error()` and clears `streaming`. */
export async function send(text: string, mode?: Mode): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  setError(null);
  setMessages((prev) => [...endStreaming(prev), newUserMessage(trimmed)]);
  setStreaming(true);
  try {
    await request({ type: 'user-message', text: trimmed, mode }, OkResult);
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
