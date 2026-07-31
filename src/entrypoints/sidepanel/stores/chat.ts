import { createSignal } from 'solid-js';
import type { Edit } from '@/shared/changeset';
import type {
  Mode,
  StableSelector,
  SwToPanel,
  ThreadViewMessage,
  TurnUsage,
} from '@/shared/messages';
import {
  OkResult,
  SessionStateResult,
  ThreadGetResult,
  UserMessageResult,
} from '@/shared/messages';
import { request } from './bus';
import { xpath as focusXpath, multiSelectors } from './focus';
import { connectPort, onReconnect, subscribeToSw } from './sw-stream';

// Chat store (slice 11, #168 turn attribution + restorable transcript): assembles the conversation
// thread from the `SwToPanel` stream — `token`/`tool-call`/`edit-recorded`/`error`/`turn-done` —
// over `sw-stream.ts`, and reconciles it against the SW's own per-tab thread via the `thread-get`
// RPC (panel open, port reconnect, tab switch). The SW is the only source of truth for what the
// agent did (CLAUDE.md "SolidJS + SRP"): this module never invents message content, it only folds
// the stream into a display-friendly shape and dispatches `user-message`/`session-stop` RPCs.
//
// Turn attribution (#168): every send is keyed by the `turnId` the `user-message` ack returns, and
// stream events are folded ONLY when their `turnId` matches (or is absent — a pre-#168 SW still
// streams unstamped events, and dropping those would blank the panel). A second window's turn, or
// a stale worker's stray event, can no longer mutate this panel's transcript.

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
   *  an attributed `error`, or a confirmed-dead turn). Always `false` for a `role: 'user'` entry. */
  streaming: boolean;
}

/** What the attribution gate knows when it classifies one stream event. */
export interface EventContext {
  /** The turn this panel is currently keyed to — the `user-message` ack's `turnId`, or the
   *  `currentTurnId` adopted during a `hydrateThread` rebuild. `null` = no keyed turn. */
  activeTurnId: string | null;
  /** Whether this panel believes a turn is in flight (the composer-level `streaming` signal). */
  streaming: boolean;
  /** The tab this panel's transcript is keyed to (from the last `thread-get` reply). */
  viewTabId: number | null;
}

/** How one stream event relates to this panel's view:
 *  - `fold` — apply it to the transcript (matching `turnId`, or unstamped for back-compat).
 *  - `drop` — another turn's / another tab's event; must not touch this transcript (#168 finding 4).
 *  - `notice` — an unattributed `error` while a turn is live: surface it as a composer-level
 *    notice WITHOUT ending the stream or closing the bubble. Pre-#168, a ship-route or
 *    history-append failure pushed mid-turn killed the live bubble (finding 1); the turn's own
 *    terminal events (`turn-done` / an attributed `error`) still close it.
 *  Pure — exported for a mock-free unit test. */
export function classifyEvent(msg: SwToPanel, ctx: EventContext): 'fold' | 'drop' | 'notice' {
  if (msg.type === 'edit-recorded') {
    // Tab-stamped like the changeset store's fold: another tab's edit never lands in this
    // transcript. Unstamped (pre-stamp emitter) or unkeyed view folds as before.
    return msg.tabId !== undefined && ctx.viewTabId !== null && msg.tabId !== ctx.viewTabId
      ? 'drop'
      : 'fold';
  }
  if (!isTurnEvent(msg)) return 'fold';
  if (msg.turnId !== undefined) {
    return msg.turnId === ctx.activeTurnId ? 'fold' : 'drop';
  }
  // Unstamped turn event — a pre-#168 SW (keep working) or a turnless/global error.
  if (msg.type === 'error' && ctx.streaming) return 'notice';
  return 'fold';
}

type TurnEvent = Extract<
  SwToPanel,
  { type: 'token' | 'tool-call' | 'tool-result' | 'turn-done' | 'error' }
>;

function isTurnEvent(msg: SwToPanel): msg is TurnEvent {
  return (
    msg.type === 'token' ||
    msg.type === 'tool-call' ||
    msg.type === 'tool-result' ||
    msg.type === 'turn-done' ||
    msg.type === 'error'
  );
}

/** Pure fold: apply one SW->panel message onto the thread. Unrelated message types are a no-op
 *  (identity). Attribution (whose turn / whose tab an event is) happens BEFORE this fold — see
 *  `classifyEvent`; the reducer assumes every event it sees belongs to this view. Exported for a
 *  mock-free unit test, mirroring `stores/mcp.ts`'s `reduceServers`. */
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
      // Only errors that belong to this view reach the fold (classifyEvent): an attributed error
      // is terminal for its turn, and an unattributed one with NO turn in flight is a global
      // failure (e.g. no provider configured) still worth a closed bubble. Either way the bubble
      // closes out — an unattributed error DURING a turn never gets here (it's a 'notice').
      return endStreaming(foldIntoAssistant(messages, (m) => ({ ...m, error: msg.message })));
    case 'turn-done':
      return endStreaming(messages);
    case 'session-state':
      // Stop (background.ts's `session-stop` handler clears `turnAbort` itself, so the aborted
      // turn never emits a `turn-done`) — the non-running state is the only settle signal. A
      // `running` push carrying `turnRunning: false` is NOT folded here any more: a reconnecting
      // panel can catch a fresh worker before it re-registers the in-flight turn, and closing the
      // bubble on that first answer re-enabled send mid-turn (#168 finding 2). The store verifies
      // via a delayed `session-get` instead — see `scheduleTurnLivenessCheck`.
      return msg.state !== 'running' ? endStreaming(messages) : messages;
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
 *  adopt it; every other message leaves the total unchanged. Foreign turns are filtered out before
 *  this fold (`classifyEvent`), so a second window's spend never lands here (#168 finding 4).
 *  Exported for a mock-free unit test. */
export function nextUsage(prev: TurnUsage, msg: SwToPanel): TurnUsage {
  return msg.type === 'turn-done' ? msg.usage : prev;
}

/** Map the SW's rendered per-tab thread (`thread-get`) onto the panel's display shape: text
 *  bubbles plus compact settled tool chips. Everything arrives closed — a rebuilt transcript never
 *  fabricates an in-flight bubble; a genuinely live turn re-opens one via its own stream events.
 *  Pure — exported for a mock-free unit test. */
export function threadToMessages(thread: ThreadViewMessage[]): ChatMessage[] {
  return thread.map((m) => ({
    id: crypto.randomUUID(),
    role: m.role,
    text: m.text,
    toolCalls: (m.tools ?? []).map((t) => ({ tool: t.name, ok: t.ok })),
    edits: [],
    streaming: false,
  }));
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
// the ack lands) so the composer can disable itself immediately, and flips false on
// `turn-done`/an attributed `error`/a stopped session/a confirmed-dead turn — whichever closes out
// the turn first. Also the send guard: while true, `send()` drops the call outright (a duplicate
// send would abort the real turn SW-side — #168 finding 2 — and it's the chip double-fire guard).
const [streaming, setStreaming] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
// Cumulative token/step spend for this session, folded from `turn-done`'s `usage` — the running
// usage meter (#25). Reset when `hydrateThread` re-keys the view to a different tab (sessions are
// per-tab); the next `turn-done` re-syncs the cumulative total.
const [usage, setUsage] = createSignal<TurnUsage>(ZERO_USAGE);
// The turn this panel is keyed to (#168): the `user-message` ack's `turnId`, or the
// `currentTurnId` adopted during a hydrate rebuild. `null` = unkeyed (idle, or a pre-#168 SW).
const [activeTurnId, setActiveTurnId] = createSignal<string | null>(null);
// The tab this transcript belongs to, from the last applied `thread-get` reply — the chat sibling
// of `stores/changeset.ts`'s `viewTabId` (sessions and threads are per-tab; #168 finding 6).
const [viewTabId, setViewTabId] = createSignal<number | null>(null);

export { activeTurnId, error, messages, streaming, usage, viewTabId };

// How long a `turnRunning: false` claim gets to prove itself before the panel believes it: a
// reconnect can reach a fresh worker BEFORE the in-flight turn re-registers, and killing the local
// stream on that first answer re-enabled send mid-turn (#168 finding 2). After this delay the
// store re-asks (`session-get`) and only a second not-running answer closes the bubble; a matching
// `turn-done`/`error` arriving meanwhile settles it first and the check no-ops.
export const TURN_LIVENESS_DELAY_MS = 750;

let livenessTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTurnLivenessCheck(): void {
  if (livenessTimer !== null) return;
  livenessTimer = setTimeout(() => {
    livenessTimer = null;
    void confirmTurnLiveness();
  }, TURN_LIVENESS_DELAY_MS);
}

async function confirmTurnLiveness(): Promise<void> {
  if (!streaming()) return; // the turn already settled through its own terminal event
  try {
    const r = await request({ type: 'session-get' }, SessionStateResult);
    const keyed = activeTurnId();
    const dead =
      !r.turnRunning ||
      (r.currentTurnId !== undefined && keyed !== null && r.currentTurnId !== keyed);
    if (!dead) return; // alive after all — the first push was the pre-restore race
    setMessages(endStreaming);
    setStreaming(false);
    setActiveTurnId(null);
  } catch {
    // Transport hiccup — keep streaming; the next state push re-schedules the check.
  }
}

// A turn's first stamped events can beat its own ack (the sendMessage reply and the Port pushes
// are unordered channels): hold what would otherwise be dropped while the ack is pending and
// replay it once the ack keys the turn, instead of losing the turn's opening tokens.
let ackPending = false;
let heldTurnEvents: SwToPanel[] = [];
const MAX_HELD_EVENTS = 200;

function onStream(msg: SwToPanel): void {
  const verdict = classifyEvent(msg, {
    activeTurnId: activeTurnId(),
    streaming: streaming(),
    viewTabId: viewTabId(),
  });
  if (verdict === 'drop') {
    if (ackPending && isTurnEvent(msg) && heldTurnEvents.length < MAX_HELD_EVENTS) {
      heldTurnEvents.push(msg);
    }
    return;
  }
  if (verdict === 'notice') {
    if (msg.type === 'error') setError(msg.message);
    return;
  }
  setMessages((prev) => reduceChat(prev, msg));
  setUsage((prev) => nextUsage(prev, msg));
  if (msg.type === 'turn-done') {
    setStreaming(false);
    setActiveTurnId(null);
  } else if (msg.type === 'error') {
    // Attributed (or turnless-while-idle) — terminal for the turn, but keep the turn key: the
    // SW still emits the settling `turn-done` (with the session's usage) after an error, and
    // dropping the key here would orphan it.
    setStreaming(false);
  } else if (msg.type === 'session-state') {
    if (msg.state !== 'running') {
      setStreaming(false);
      setActiveTurnId(null);
    } else if (msg.turnRunning === false && streaming()) {
      scheduleTurnLivenessCheck();
    }
  }
}

let wired = false;

/** Open the SW port, fold incoming stream messages into the thread, and rebuild the transcript
 *  from the SW's per-tab thread — on mount, on every port reconnect, and on every tab/window
 *  switch (the thread is per-tab, like the changeset). Idempotent — safe to call on every
 *  ChatPanel mount. */
export function initChatStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw(onStream);
  void hydrateThread();
  onReconnect(() => void hydrateThread());
  // The side panel is window-scoped but the thread is per-tab: follow tab switches so the chat
  // always shows the conversation of the tab the user is looking at — same subscription shape as
  // stores/changeset.ts (guarded — the unit-test chrome fake carries only `runtime`).
  const retarget = (): void => void hydrateThread();
  chrome.tabs?.onActivated?.addListener?.(retarget);
  chrome.windows?.onFocusChanged?.addListener?.(retarget);
}

// Monotonic guard so overlapping hydrates (rapid tab switches, reconnect during mount) apply only
// the newest pair of replies — mirrors stores/changeset.ts's `refreshSeq`.
let hydrateSeq = 0;

/** Rebuild the transcript from the SW's per-tab thread (#168 finding 3): `session-get` for the
 *  lifecycle + in-flight turn, `thread-get` for the rendered messages. The rebuilt view replaces
 *  the local replica wholesale — the SW thread is the source of truth — and an in-flight turn is
 *  ADOPTED (`currentTurnId` becomes the active key) so a reopened panel re-attaches to it. The
 *  adoption rule (#168 finding 4/E): `currentTurnId` is adopted ONLY here, immediately after a
 *  wholesale thread-get rebuild — never from a bare `session-state` push — so a panel that merely
 *  observes another window's stream stays unkeyed and drops those events, while a panel that just
 *  rebuilt shows a coherent transcript for the turn it adopts. Failures leave the current view
 *  untouched (hydration is advisory; the next trigger retries). */
export async function hydrateThread(): Promise<void> {
  const seq = ++hydrateSeq;
  try {
    const s = await request({ type: 'session-get' }, SessionStateResult);
    if (seq !== hydrateSeq) return;
    const t = await request({ type: 'thread-get' }, ThreadGetResult);
    if (seq !== hydrateSeq) return;
    if (!t.ok) {
      // "No session for this tab" — an empty chat is the truth for that tab. Re-key and clear
      // rather than keep showing another tab's transcript over it.
      if (viewTabId() !== t.tabId) setUsage(ZERO_USAGE);
      setViewTabId(t.tabId);
      setMessages([]);
      setActiveTurnId(null);
      setStreaming(false);
      return;
    }
    if (viewTabId() !== t.tabId) setUsage(ZERO_USAGE); // per-tab spend; next turn-done re-syncs
    setViewTabId(t.tabId);
    setMessages(threadToMessages(t.thread ?? []));
    setActiveTurnId(s.turnRunning ? (s.currentTurnId ?? null) : null);
    setStreaming(s.turnRunning);
  } catch {
    // Advisory: a failed hydrate (pre-#168 SW without `thread-get`, transport blip) keeps the
    // stream-built view as-is instead of blanking it.
  }
}

/** Send a user instruction. The local append is ACK-GATED (#168 finding 3/D): the user bubble
 *  lands only once the SW's `UserMessageResult` says ok, and a rejected send surfaces as a
 *  composer-level notice (`error()`) instead of a phantom bubble the SW never received. While a
 *  turn is streaming the call is dropped outright — the composer already gates its button, and
 *  this same guard covers the suggestion-chip path's double-fire (#168 finding 5) and keeps a
 *  duplicate send from aborting the real turn SW-side (finding 2). Never throws.
 *
 *  `selector` is the PICKED ELEMENT the composer's context chip is showing — the referent of
 *  "this" (#165 S6). The shift-multi-select set rides along the same way, read straight off the
 *  focus store (the composer passes one pin, not the set). */
export async function send(text: string, mode?: Mode, selector?: StableSelector): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || streaming()) return;
  setError(null);
  setStreaming(true);
  ackPending = true;
  const multi = multiSelectors();
  try {
    const r = await request(
      {
        type: 'user-message',
        text: trimmed,
        mode,
        selector,
        // Only meaningful alongside the single pin — a multi-select grounds on its selectors.
        xpath: selector ? (focusXpath() ?? undefined) : undefined,
        // Omitted when empty: an empty array is the "user cleared it" signal on the way IN, and
        // grounding a turn on nothing is not the same message as not grounding it at all.
        selectors: multi.length > 0 ? multi : undefined,
      },
      UserMessageResult,
    );
    if (!r.ok) {
      setStreaming(false);
      setError(r.error ?? 'The agent did not accept the message. Try again.');
      return;
    }
    // An accepted send supersedes any hydrate still in flight (its replies predate this message —
    // applying them would wipe the bubble just appended). Same last-writer-wins rule as the
    // changeset store's viewSeq.
    hydrateSeq++;
    setMessages((prev) => [...prev, newUserMessage(trimmed)]);
    // Key the panel to this turn (`null` = a pre-#168 SW that acks without a turnId — unstamped
    // events keep folding), then replay any stamped events that beat the ack.
    setActiveTurnId(r.turnId ?? null);
    const held = heldTurnEvents;
    heldTurnEvents = [];
    ackPending = false;
    for (const m of held) onStream(m);
  } catch (e) {
    setStreaming(false);
    setError(errMsg(e));
  } finally {
    ackPending = false;
    heldTurnEvents = [];
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
