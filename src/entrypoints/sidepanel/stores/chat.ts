import { createSignal } from 'solid-js';
import type { Attachment, Attachments } from '@/shared/attachments';
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

/** One ordered slice of an assistant turn. The model alternates prose and tool runs
 *  (text → calls → text → calls…), and flattening that into "all prose, then all chips" misstated
 *  what happened — a retry narrated AFTER a failed call rendered ABOVE it. A `text` segment is a
 *  run of streamed tokens; a `tools` segment is the burst of calls between two runs of prose. */
export type Segment = { kind: 'text'; text: string } | { kind: 'tools'; calls: ToolCallEntry[] };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** The turn in the order it actually happened. SOURCE OF TRUTH for the bubble's body —
   *  `text`/`toolCalls` below are flattenings derived from it on every fold. */
  segments: Segment[];
  /** All prose, concatenated in segment order. DERIVED — kept because the working-line gate
   *  ("is the reply still empty?"), `mergeInFlight` and the tests read the turn flat. */
  text: string;
  /** All calls, concatenated in segment order. DERIVED — `turn-phase.ts` takes the flat list. */
  toolCalls: ToolCallEntry[];
  edits: Edit[];
  error?: string;
  /** True while this assistant turn is still receiving stream events (cleared by `turn-done`,
   *  an attributed `error`, or a confirmed-dead turn). Always `false` for a `role: 'user'` entry. */
  streaming: boolean;
  /** Reference material this USER turn was sent with (`src/shared/attachments.ts`) — kept so the
   *  thread can render what was handed over instead of the mockups vanishing on send. Local to
   *  this replica: `threadToMessages` rebuilds from the SW's thread view, which carries no
   *  attachment data, so a rehydrated old turn simply has none. That is correct — the SW is the
   *  source of truth for what was SAID, and the bytes are not worth re-shipping to redraw a
   *  thumbnail. */
  attachments?: Attachment[];
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
      return foldIntoAssistant(messages, (m) => withSegments(m, appendToken(m.segments, msg.text)));
    case 'tool-call':
      return foldIntoAssistant(messages, (m) =>
        withSegments(
          m,
          appendCall(m.segments, {
            tool: msg.tool,
            selector: msg.selector,
            kind: msg.kind,
            id: msg.id,
          }),
        ),
      );
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

/** All prose in segment order — the derived `text` flattening. */
function textOf(segments: Segment[]): string {
  let out = '';
  for (const s of segments) if (s.kind === 'text') out += s.text;
  return out;
}

/** All calls in segment order — the derived `toolCalls` flattening. */
function callsOf(segments: Segment[]): ToolCallEntry[] {
  return segments.flatMap((s) => (s.kind === 'tools' ? s.calls : []));
}

/** Adopt `segments` as the message's new body and re-derive the flat views from it, so the
 *  aggregates can never drift from the ordered truth. */
function withSegments(m: ChatMessage, segments: Segment[]): ChatMessage {
  return { ...m, segments, text: textOf(segments), toolCalls: callsOf(segments) };
}

/** A token grows the trailing text segment, or opens one when the turn just moved out of a tool
 *  burst (or has not started). Pure — always a new array + new tail object, never a mutation. */
function appendToken(segments: Segment[], text: string): Segment[] {
  const tail = segments.at(-1);
  if (tail?.kind === 'text') {
    return [...segments.slice(0, -1), { kind: 'text', text: tail.text + text }];
  }
  return [...segments, { kind: 'text', text }];
}

/** A call joins the trailing tools segment, or opens one when the model just stopped narrating. */
function appendCall(segments: Segment[], call: ToolCallEntry): Segment[] {
  const tail = segments.at(-1);
  if (tail?.kind === 'tools') {
    return [...segments.slice(0, -1), { kind: 'tools', calls: [...tail.calls, call] }];
  }
  return [...segments, { kind: 'tools', calls: [call] }];
}

/** Fold one `tool-result` onto the call it settles: by `id` when the SW carried one, else the
 *  newest still-unsettled call of the same name (the fallback the bus schema documents). The call
 *  may live in ANY tools segment — the model has usually moved on to narrating (or a later burst)
 *  by the time a slow call reports back. Never opens a bubble — an outcome with no call to attach
 *  to is dropped rather than invented. */
function settleToolCall(
  messages: ChatMessage[],
  msg: Extract<SwToPanel, { type: 'tool-result' }>,
): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return messages;
  const loc = locateToolCall(last.segments, msg);
  if (!loc) return messages;
  const seg = last.segments[loc.seg];
  if (seg?.kind !== 'tools') return messages; // unreachable — locateToolCall only returns tools
  const target = seg.calls[loc.call];
  if (!target) return messages;
  const calls = seg.calls.slice();
  calls[loc.call] = { ...target, ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) };
  const segments = last.segments.slice();
  segments[loc.seg] = { kind: 'tools', calls };
  return [...messages.slice(0, -1), withSegments(last, segments)];
}

/** Where the settling call lives: by id anywhere in the turn, else the newest still-unsettled
 *  call of the same name, scanning segments (and calls within them) newest-first. */
function locateToolCall(
  segments: Segment[],
  msg: Extract<SwToPanel, { type: 'tool-result' }>,
): { seg: number; call: number } | null {
  if (msg.id) {
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      if (seg?.kind !== 'tools') continue;
      const byId = seg.calls.findIndex((c) => c.id === msg.id);
      if (byId !== -1) return { seg: s, call: byId };
    }
  }
  for (let s = segments.length - 1; s >= 0; s--) {
    const seg = segments[s];
    if (seg?.kind !== 'tools') continue;
    for (let i = seg.calls.length - 1; i >= 0; i--) {
      const c = seg.calls[i];
      if (c?.tool === msg.tool && c.ok === undefined) return { seg: s, call: i };
    }
  }
  return null;
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
  return thread.map((m) => {
    const toolCalls: ToolCallEntry[] = (m.tools ?? []).map((t) => ({ tool: t.name, ok: t.ok }));
    // The persisted thread view carries NO interleaving info (text and tools arrive as two flat
    // fields), so a rehydrated turn maps to AT MOST TWO segments — one text, one tools, in the
    // order the pre-segment UI always rendered them. Losing the interleave on restore is accepted:
    // the SW is the source of truth for what was said, not for the order it streamed in.
    const segments: Segment[] = [
      ...(m.text.length > 0 ? [{ kind: 'text', text: m.text } as const] : []),
      ...(toolCalls.length > 0 ? [{ kind: 'tools', calls: toolCalls } as const] : []),
    ];
    return {
      id: crypto.randomUUID(),
      role: m.role,
      segments,
      text: m.text,
      toolCalls,
      edits: [],
      streaming: false,
    };
  });
}

/** Whether this panel's OWN in-flight turn must survive a `thread-get` rebuild.
 *  `thread-get` renders the SW's PERSISTED thread, and background.ts appends a turn's assistant
 *  messages only once the whole turn resolves — so mid-turn the rebuild provably cannot contain
 *  what this panel has just streamed. While this panel believes a turn is streaming, its in-flight
 *  tail outranks the rebuild — UNLESS the SW names a DIFFERENT turn as running (the one case the
 *  local bubble is provably stale). `turnRunning: false` is deliberately NOT enough to overrule:
 *  a reconnect can reach a fresh worker before the turn re-registers; that claim is verified by
 *  `scheduleTurnLivenessCheck`, which closes the bubble WITHOUT deleting its text. */
export function keepsLocalTurn(
  local: { streaming: boolean; activeTurnId: string | null },
  sw: { turnRunning: boolean; currentTurnId?: string },
): boolean {
  if (!local.streaming) return false;
  if (sw.currentTurnId !== undefined && local.activeTurnId !== null) {
    return sw.currentTurnId === local.activeTurnId;
  }
  // One id missing (the window between send and the first stamped event, or an SW that names no
  // turn): protect anyway. A stricter branch cannot tell "our turn, no stamp yet" from "stale
  // panel", and the failure modes are not symmetric — over-protecting defers a rebuild until the
  // turn settles (flushPendingRehydrate) or the liveness check closes the bubble; under-protecting
  // deletes streamed text the SW has not persisted, which is the P0 this guard exists to stop.
  return true;
}

/** Persisted history + this panel's live tail: everything from the in-flight assistant bubble
 *  onward (`foldIntoAssistant` only ever streams the LAST message, so there is at most one).
 *  The local USER bubble is dropped in favour of the persisted copy rather than duplicated — the
 *  SW appends the user message before the turn runs. With nothing in flight the rebuild wins. */
export function mergeInFlight(persisted: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const from = local.findIndex((m) => m.role === 'assistant' && m.streaming);
  return from === -1 ? persisted : [...persisted, ...local.slice(from)];
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
    segments: [],
    text: '',
    toolCalls: [],
    edits: [],
    streaming: true,
  };
}

function newUserMessage(text: string, attachments?: Attachments): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    // A user turn is one utterance — a single text segment, no tool bursts to interleave with.
    segments: [{ kind: 'text', text }],
    text,
    toolCalls: [],
    edits: [],
    streaming: false,
    // Omitted rather than empty, so a turn with nothing attached is the object it always was.
    ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
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
    flushPendingRehydrate();
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

// Which conversation a `send` belongs to. `newConversation` advances it, so a send whose ack is
// still in flight when the reset lands sees the bump and drops its ack instead of appending the
// reset-away bubble to the fresh transcript (the SW-side reset stands down for a NEWER turn; this
// is the mirror rule for a send the reset beat).
let conversationGen = 0;

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
    flushPendingRehydrate();
  } else if (msg.type === 'error') {
    // Attributed (or turnless-while-idle) — terminal for the turn, but keep the turn key: the
    // SW still emits the settling `turn-done` (with the session's usage) after an error, and
    // dropping the key here would orphan it.
    setStreaming(false);
  } else if (msg.type === 'session-state') {
    if (msg.state !== 'running') {
      setStreaming(false);
      setActiveTurnId(null);
      flushPendingRehydrate();
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

// A retarget that arrived while this panel's own turn was streaming is SKIPPED, not applied — the
// live turn outranks it. Remembered and re-fired when the turn settles, so the panel still ends
// up on the tab the user is looking at.
let pendingRehydrate = false;

function flushPendingRehydrate(): void {
  if (!pendingRehydrate) return;
  pendingRehydrate = false;
  void hydrateThread();
}

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
    // Pinned to the tab this transcript is keyed to ONLY while this panel believes a turn is in
    // flight: mid-turn the transcript belongs to the turn's tab (and the pin protects even across
    // an SW restart that lost `runningTurnTabId`), so a tab switch must not re-target the query
    // away from it. Between turns the ask is deliberately UNPINNED — the SW's own resolution
    // (running turn's tab → active tab with a session → last turn's tab) is what implements "the
    // chat follows the tab you're looking at", and a standing pin would freeze the panel on its
    // first conversation forever (an explicit ask wins SW-side whenever the pinned tab has a
    // session).
    const t = await request(
      { type: 'thread-get', tabId: streaming() ? (viewTabId() ?? undefined) : undefined },
      ThreadGetResult,
    );
    if (seq !== hydrateSeq) return;
    if (keepsLocalTurn({ streaming: streaming(), activeTurnId: activeTurnId() }, s)) {
      // Never `setMessages([])`, never drop the turn key (`classifyEvent` would then DROP the rest
      // of this turn's own stamped events), never lower `streaming` (that turns Stop back into
      // Send while the agent is still editing the page).
      if (!t.ok || t.tabId !== viewTabId()) {
        pendingRehydrate = true; // nothing to merge for a tab this transcript isn't keyed to
        return;
      }
      setMessages((local) => mergeInFlight(threadToMessages(t.thread ?? []), local));
      if (!s.turnRunning) scheduleTurnLivenessCheck(); // verify, don't act on the first answer
      return;
    }
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
 *  focus store (the composer passes one pin, not the set).
 *
 *  `attachments` is the draft's reference material (`stores/attachments.ts`). RETURNS whether the
 *  SW accepted the send: the composer clears its tray only on `true`, so a rejected send does not
 *  cost the user the six mockups they just picked. Existing callers that ignore the result are
 *  unaffected. */
export async function send(
  text: string,
  mode?: Mode,
  selector?: StableSelector,
  attachments?: Attachments,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || streaming()) return false;
  setError(null);
  setStreaming(true);
  ackPending = true;
  const gen = conversationGen;
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
        // Same rule, one step further: the KEY is absent when nothing is attached, so a send with
        // no reference material is byte-identical to a pre-attachment `user-message`.
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
      UserMessageResult,
    );
    // A reset advanced the conversation while this ack was in flight: the ack is dead news for a
    // transcript that no longer exists. Touch nothing — `newConversation` already normalized the
    // local state, and appending here would resurrect the reset-away bubble.
    if (gen !== conversationGen) return false;
    if (!r.ok) {
      setStreaming(false);
      setError(r.error ?? 'The agent did not accept the message. Try again.');
      return false;
    }
    // An accepted send supersedes any hydrate still in flight (its replies predate this message —
    // applying them would wipe the bubble just appended). Same last-writer-wins rule as the
    // changeset store's viewSeq.
    hydrateSeq++;
    setMessages((prev) => [...prev, newUserMessage(trimmed, attachments)]);
    // Key the panel to this turn (`null` = a pre-#168 SW that acks without a turnId — unstamped
    // events keep folding), then replay any stamped events that beat the ack.
    setActiveTurnId(r.turnId ?? null);
    const held = heldTurnEvents;
    heldTurnEvents = [];
    ackPending = false;
    for (const m of held) onStream(m);
    return true;
  } catch (e) {
    if (gen === conversationGen) {
      setStreaming(false);
      setError(errMsg(e));
    }
    return false;
  } finally {
    ackPending = false;
    heldTurnEvents = [];
  }
}

/** Start a FRESH conversation on the current tab (the chat toolbar's "New conversation").
 *
 *  The SW does the real work (`conversation-new`): aborts any in-flight turn the way Stop does,
 *  waits for its finalization to ARCHIVE the partial to history, then resets its per-tab thread +
 *  debug log and re-keys the changeset — the recorded edits survive, because the live page still
 *  carries them. Only after the SW acks does this replica reset: transcript cleared, turn key
 *  dropped, streaming off, usage zeroed — then a hydrate confirms against the SW's (now empty)
 *  thread, exactly the "empty chat is the truth for this tab" path `hydrateThread` already owns.
 *  Pinned to the conversation this panel is SHOWING (`viewTabId`), same rule as `copyDebugLog`.
 *  Returns whether the SW accepted; a refusal surfaces as a composer-level notice and leaves the
 *  transcript untouched. Never throws. */
export async function newConversation(): Promise<boolean> {
  try {
    const r = await request(
      { type: 'conversation-new', tabId: viewTabId() ?? undefined },
      OkResult,
    );
    if (!r.ok) {
      setError(r.error ?? 'Could not start a new conversation.');
      return false;
    }
  } catch (e) {
    setError(errMsg(e));
    return false;
  }
  // The reset supersedes any hydrate still in flight — its replies predate the reset and would
  // resurrect the archived transcript (same last-writer-wins rule as `send`). Same for a send
  // whose ack hasn't landed: advance the generation so the delayed ack drops instead of appending
  // its bubble to the fresh transcript, and drop the events it was holding for a turn that's over.
  conversationGen++;
  ackPending = false;
  heldTurnEvents = [];
  hydrateSeq++;
  setMessages([]);
  setStreaming(false);
  setActiveTurnId(null);
  setUsage(ZERO_USAGE);
  setError(null);
  void hydrateThread();
  return true;
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
