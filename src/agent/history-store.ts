// Persisted history of the last 10 conversations with the agent — the durable record slice 08 asks
// for beyond the ephemeral chat scrollback (`ChatPanel.tsx` holds only the live signal). A ring
// buffer of `Conversation`s in `chrome.storage.local`, capped at 10 and size-bounded: screenshots
// (data-URL image parts inside a persisted message) are stripped to a placeholder and any other
// over-long string is truncated, so a long or screenshot-heavy thread never blows storage.local's
// per-item quota. A finished session's handoff brief is attached as its rendered Markdown text
// (07), never as raw images. Injectable clock (`now`) so `createdAt` is deterministic under test —
// mirrors `agent/session.ts`'s `SessionStore` pattern.
//
// SW-ONLY (touches `chrome.storage.local`); never import from content.ts. Chrome-free by
// construction otherwise — the storage calls are the only I/O, so this is unit-testable against an
// in-memory `chrome.storage.local` fake with no real extension runtime.

import { modelMessageSchema } from 'ai';
import { z } from 'zod';
import { Mode } from '@/shared/messages';
import type { ChatMessage } from './session';

const STORAGE_KEY = 'history:conversations';
/** Ring-buffer capacity — "last 10 conversations" per the vision doc. */
const CAP = 10;
/** Per-conversation message cap enforced on write — bounds a single very long-running thread
 *  independently of the 10-conversation ring buffer. */
const MAX_MESSAGES = 200;
const MAX_TITLE_CHARS = 200;
const MAX_REPORT_CHARS = 20_000;
/** Any single string leaf longer than this (outside a recognized data-URL image) is truncated. */
const MAX_STRING_CHARS = 4_000;
const IMAGE_PLACEHOLDER = '[image omitted from history]';

// One persisted conversation: the turn thread + whatever the session produced (a handoff report,
// the PR it became). `messages`/`report` are bounded on write by `boundMessages`/`MAX_REPORT_CHARS`
// below — never trust an unbounded value in from storage either, hence the schema caps too.
export const Conversation = z.object({
  id: z.string().min(1),
  title: z.string().max(MAX_TITLE_CHARS),
  url: z.string(),
  mode: Mode.optional(),
  createdAt: z.number(),
  messages: z.array(modelMessageSchema).max(MAX_MESSAGES).default([]),
  /** The handoff brief (07), already rendered to Markdown — never the raw `Report` object or any
   *  embedded images; keeps a history entry cheap to list and safe to store. */
  report: z.string().max(MAX_REPORT_CHARS).optional(),
  /** The PR the ship flow (12) opened from this conversation's changeset. */
  prLink: z.string().max(2048).optional(),
});
export type Conversation = z.infer<typeof Conversation>;

// A history-list row: everything but the heavy fields, plus counts the panel can render without
// pulling the full thread over the bus (`history-list` vs `history-get(id)` in the RPC step).
export const ConversationSummary = Conversation.omit({ messages: true, report: true }).extend({
  messageCount: z.number().int().nonnegative(),
  hasReport: z.boolean(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export interface HistoryStoreOptions {
  /** Injectable clock for a new conversation's `createdAt` (tests pin it — no `Date.now()` here). */
  readonly now?: () => number;
}

/**
 * The service worker's conversation-history store: a cap-10 ring buffer mirrored to
 * `chrome.storage.local`, newest conversation first. Call `hydrate()` once on SW wake before
 * serving history RPCs, then use the synchronous `list()`/`get()` on the hot path; every mutation
 * persists. A conversation is keyed by its session id — `appendTurn` creates it on first use.
 */
export class HistoryStore {
  private cache: Conversation[] = []; // newest-first
  private readonly now: () => number;

  constructor(options: HistoryStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Load the persisted ring buffer into the cache. Idempotent — safe to call on each SW wake
   *  before the first message is served. A corrupt/legacy record is dropped rather than trusted. */
  async hydrate(): Promise<void> {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const raw = got[STORAGE_KEY];
    if (raw === undefined) {
      this.cache = [];
      return;
    }
    const parsed = z.array(Conversation).safeParse(raw);
    if (parsed.success) {
      this.cache = parsed.data.slice(0, CAP);
    } else {
      this.cache = [];
      await chrome.storage.local.remove(STORAGE_KEY);
    }
  }

  /** The 10 (or fewer) conversations, newest first, as list-view summaries. */
  list(): ConversationSummary[] {
    return this.cache.map(toSummary);
  }

  /** One conversation's full record (thread + report/PR link), or `undefined` if it isn't in
   *  history (evicted, deleted, or never appended). */
  get(id: string): Conversation | undefined {
    return this.cache.find((c) => c.id === id);
  }

  /** Number of conversations currently held (≤ 10). */
  get size(): number {
    return this.cache.length;
  }

  /**
   * Append a completed turn to history. Creates the conversation on first use — inserted at the
   * front of the ring buffer, evicting the oldest past the cap-10 limit — or extends an existing
   * one's thread in place (position unchanged; only a brand-new id competes for a ring-buffer
   * slot). Messages are size-bounded before persisting (see {@link boundMessages}). Call this on
   * turn-done.
   */
  async appendTurn(input: {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly mode?: Mode;
    readonly messages: readonly ChatMessage[];
  }): Promise<Conversation> {
    const existing = this.get(input.id);
    const next: Conversation = existing
      ? {
          ...existing,
          url: input.url,
          mode: input.mode ?? existing.mode,
          messages: boundMessages([...existing.messages, ...input.messages]),
        }
      : {
          id: input.id,
          title: input.title.slice(0, MAX_TITLE_CHARS),
          url: input.url,
          mode: input.mode,
          createdAt: this.now(),
          messages: boundMessages(input.messages),
        };
    return this.upsert(next);
  }

  /** Attach/replace the handoff report's rendered Markdown (07) on a conversation already in
   *  history. Throws if `id` isn't present — `appendTurn` first. */
  async setReport(id: string, report: string): Promise<Conversation> {
    const current = this.require(id);
    return this.upsert({ ...current, report: report.slice(0, MAX_REPORT_CHARS) });
  }

  /** Attach/replace the PR link a ship (12) produced from this conversation. Throws if `id` isn't
   *  present — `appendTurn` first. */
  async setPrLink(id: string, prLink: string): Promise<Conversation> {
    const current = this.require(id);
    return this.upsert({ ...current, prLink });
  }

  /** Remove a conversation from history (user-triggered delete). No-op for an unknown id. */
  async delete(id: string): Promise<void> {
    if (!this.cache.some((c) => c.id === id)) return;
    this.cache = this.cache.filter((c) => c.id !== id);
    await this.persist();
  }

  private require(id: string): Conversation {
    const found = this.get(id);
    if (!found) throw new Error(`No conversation ${id} in history; call appendTurn() first`);
    return found;
  }

  private async upsert(conversation: Conversation): Promise<Conversation> {
    const idx = this.cache.findIndex((c) => c.id === conversation.id);
    if (idx >= 0) {
      this.cache = this.cache.map((c, i) => (i === idx ? conversation : c));
    } else {
      // New conversation: front of the ring buffer; the 11th push evicts the oldest (last).
      this.cache = [conversation, ...this.cache].slice(0, CAP);
    }
    await this.persist();
    return conversation;
  }

  private async persist(): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: this.cache });
  }
}

// --- size-bounding (pure, exported for unit coverage) ------------------------------------------

/** A history-list row for one conversation: heavy fields (`messages`, `report`) dropped in favor of
 *  cheap counts. */
function toSummary(conversation: Conversation): ConversationSummary {
  const { messages, report, ...rest } = conversation;
  return { ...rest, messageCount: messages.length, hasReport: report !== undefined };
}

function isDataUrl(value: string): boolean {
  return value.startsWith('data:');
}

/** Deep-walk a JSON-serializable value, replacing data-URL payloads (the size hog — a single
 *  captured screenshot easily runs hundreds of KB) with a short placeholder, and truncating any
 *  other over-long string. Structure — keys, array shape, discriminant fields like `role`/`type` —
 *  is preserved; only oversized leaf strings shrink, so the result still fits `modelMessageSchema`. */
export function boundValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (isDataUrl(value)) return IMAGE_PLACEHOLDER;
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  }
  if (Array.isArray(value)) return value.map(boundValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundValue(v)]));
  }
  return value;
}

/** Bound a turn's messages for history persistence: keep at most the most recent
 *  {@link MAX_MESSAGES}, then strip/truncate oversized string payloads throughout (see
 *  {@link boundValue}). Re-validated against `modelMessageSchema` — a message that somehow fails to
 *  parse after bounding is dropped rather than persisting something the schema would reject on the
 *  next `hydrate()`. */
export function boundMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const recent = messages.slice(-MAX_MESSAGES);
  const bounded: ChatMessage[] = [];
  for (const message of recent) {
    const parsed = modelMessageSchema.safeParse(boundValue(message));
    if (parsed.success) bounded.push(parsed.data);
  }
  return bounded;
}
