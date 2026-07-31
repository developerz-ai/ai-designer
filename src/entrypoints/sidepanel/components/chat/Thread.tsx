import { createEffect, createSignal, Index, onCleanup } from 'solid-js';
import type { ChatMessage } from '../../stores/chat';
import { Message } from './Message';
import './Thread.scss';

// The scrollable message list — renders whatever `stores/chat.ts` hands it and auto-scrolls to
// the newest content, including mid-stream token growth. No store import, no fetching: the SW
// stream is folded into `messages` upstream (CLAUDE.md "SolidJS + SRP" — this just lays them out).
export interface ThreadProps {
  messages: ChatMessage[];
}

/** How long the finished reply stays in the live region before it is emptied. Long enough that a
 *  screen reader has taken the final insertion off the queue, short enough that the region is
 *  empty again well before the next turn starts. */
const ANNOUNCE_CLEAR_MS = 500;

/** The part of an in-flight reply that ends on a sentence boundary, or `''` if no sentence has
 *  completed yet. Announcing per token machine-guns a screen reader with fragments; announcing
 *  whole sentences is the arrangement WCAG/APG actually asks for. Pure + greedy: matches through
 *  the LAST terminator that is followed by whitespace or end-of-text, so `1.5rem` mid-sentence is
 *  not mistaken for a full stop. */
export function sentencePrefix(text: string): string {
  const match = text.match(/^[\s\S]*[.!?…](?=\s|$)/);
  return match ? match[0] : '';
}

export function Thread(props: ThreadProps) {
  let logEl: HTMLUListElement | undefined;

  // Reruns on every fold of the stream (new message, growing token text, streaming flag flip) —
  // reading `.length`/last message's `text`/`streaming` inside the effect is what makes Solid track
  // them as dependencies, not just the array reference changing.
  createEffect(() => {
    const last = props.messages.at(-1);
    void props.messages.length;
    void last?.text;
    void last?.streaming;
    const el = logEl;
    if (!el) return;
    queueMicrotask(() => {
      el.scrollTop = el.scrollHeight;
    });
  });

  // ── Streaming announcements ────────────────────────────────────────────────────────────────
  // The transcript itself is deliberately NOT a live region: making the whole list live means
  // every scroll-back edit, every chip that resolves, re-announces. Only the reply currently in
  // flight is mirrored into a polite log, and only at sentence boundaries.
  //
  // Plain `let`s rather than signals for the bookkeeping: this effect writes `announced`, and a
  // signal it also read would re-trigger itself.
  const [announced, setAnnounced] = createSignal('');
  let mirroredTurn: string | undefined;
  let announcedLen = 0;
  let settledTurn: string | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  function stopClearTimer(): void {
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  }

  function announce(text: string): void {
    announcedLen = text.length;
    setAnnounced(text);
  }

  createEffect(() => {
    const last = props.messages.at(-1);
    // A user's own instruction is never announced back at them — it also means the region is
    // emptied the moment someone sends, before the next reply starts landing in it.
    const turn = last?.role === 'assistant' ? last : undefined;

    if (turn?.id !== mirroredTurn) {
      stopClearTimer();
      mirroredTurn = turn?.id;
      announcedLen = 0;
      setAnnounced('');
    }
    if (!turn) return;

    if (turn.streaming) {
      const settled = sentencePrefix(turn.text);
      if (settled.length > announcedLen) announce(settled);
      return;
    }

    // Turn finished: flush the tail that never closed a sentence (a one-line reply with no full
    // stop would otherwise never be announced at all), then empty the region so a later mutation
    // of this subtree cannot re-announce the whole thing. `settledTurn` makes that one-shot — a
    // re-render after the flush must not push the text back in.
    if (settledTurn === turn.id) return;
    settledTurn = turn.id;
    if (turn.text.length > announcedLen) announce(turn.text);
    if (announcedLen > 0) {
      clearTimer = setTimeout(() => {
        clearTimer = undefined;
        announcedLen = 0;
        setAnnounced('');
      }, ANNOUNCE_CLEAR_MS);
    }
  });

  onCleanup(stopClearTimer);

  return (
    <>
      <ul class="dz-thread" ref={logEl}>
        {/* `Index` (keyed by position, not object identity) keeps each row's subtree mounted while
            its `ChatMessage` is replaced wholesale every stream fold (`stores/chat.ts` returns a new
            last-message object per token). A keyed `<For>` would dispose+remount the streaming row on
            every token — re-parsing markdown and resetting ToolChip expand state. The thread is
            append-only (rows never reorder), so position keying is exact.
            No `role` here or on the rows: `role="user"`/`role="assistant"` are not ARIA roles, so
            browsers dropped them and every message fell back to a generic element anyway. */}
        <Index each={props.messages}>
          {(m) => (
            <Message
              role={m().role}
              text={m().text}
              streaming={m().streaming}
              error={m().error}
              toolCalls={m().toolCalls}
              edits={m().edits}
            />
          )}
        </Index>
      </ul>
      {/* `polite` — a model reply is not an emergency, and frequent interruptions actively harm
          usability. `aria-atomic="false"` is stated explicitly even though it is the default: a
          `true` anywhere up the tree wins silently, and then every appended sentence re-announces
          the entire accumulated reply, growing quadratically. */}
      <div class="dz-thread__announcer" role="log" aria-live="polite" aria-atomic="false">
        {announced()}
      </div>
    </>
  );
}
