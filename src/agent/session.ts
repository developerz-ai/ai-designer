// Per-tab design session — the durable spine of a turn. MV3 can evict the service worker at
// any idle moment (docs/architecture/mv3-worlds.md "Service-worker ephemerality"), so the
// in-flight turn's thread + the accumulated changeset are mirrored to `chrome.storage.session`
// and rehydrated on wake. This is the real backing for the `sessions` Map in `background.ts` —
// an in-memory cache for the fast path, persisted so an interrupted turn resumes with context.
//
// SW-ONLY (touches `chrome.storage.session`); never import from content.ts. The `chat
// scrollback` source of truth stays the side panel — here we keep only what the SW itself
// needs to resume: the changeset (durable output) and the model-message thread.

import { modelMessageSchema } from 'ai';
import { z } from 'zod';
import { Changeset, emptyChangeset } from '@/shared/changeset';
import { Mode } from '@/shared/messages';
import { compactSessionThread } from './thread-compact';

// A single conversation message in AI SDK shape. `ModelMessage` isn't exported from `ai`, so
// derive it from the exported schema — the same schema we validate persisted threads against.
export type ChatMessage = z.infer<typeof modelMessageSchema>;

// Mirrors the panel's session-state stream (`SwToPanel` session-state): a turn is idle,
// actively running, or stopped (user hit Stop / it was aborted).
export const TurnStatus = z.enum(['idle', 'running', 'stopped']);
export type TurnStatus = z.infer<typeof TurnStatus>;

// One tab's session as persisted to `chrome.storage.session`. Validated on rehydrate so a
// corrupt or stale-schema record is dropped rather than trusted. `messages` is the full model
// thread the SW threads back into the next turn — since #168 that INCLUDES tool activity
// (assistant tool-call parts + tool-result messages from `TurnOutcome.responseMessages`), run
// through `compactForThread` by the caller first so image payloads are placeholders and long
// outputs are truncated. `appendMessages` applies the high-water compaction
// (`compactSessionThread`) so a long session digests its oldest turns instead of growing
// forever.
export const TurnSession = z.object({
  tabId: z.number().int(),
  url: z.string(),
  changeset: Changeset,
  messages: z.array(modelMessageSchema).default([]),
  usage: z
    .object({
      steps: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    })
    .default({ steps: 0, tokens: 0 }),
  status: TurnStatus.default('idle'),
  // The mode the session's LAST turn resolved to (#168) — `resolveMode`'s fallback, so a
  // follow-up message with no mode keyword keeps the running activity instead of silently
  // dropping the copy/debug addendum. Additive + optional: pre-#168 stored sessions parse fine.
  lastMode: Mode.optional(),
  updatedAt: z.number(),
});
export type TurnSession = z.infer<typeof TurnSession>;

const KEY_PREFIX = 'session:';
const sessionKey = (tabId: number): string => `${KEY_PREFIX}${tabId}`;

export interface SessionStoreOptions {
  /** Injectable clock for `updatedAt` / new-changeset timestamps (tests pin it). */
  readonly now?: () => number;
}

/**
 * The service worker's design-session store: an in-memory cache mirrored to
 * `chrome.storage.session`. Call `hydrate()` once on SW wake before serving messages, then use
 * the synchronous `get()` on the hot path; every mutation persists. Keyed by tab id — a tab is
 * one design session.
 */
export class SessionStore {
  private readonly cache = new Map<number, TurnSession>();
  private readonly now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Load every persisted session into the cache. Salvage is PER-SESSION (audited for #168):
   *  each `session:<tabId>` key parses independently, so one corrupt/stale-schema record drops
   *  (and removes) only itself — every other tab's session survives a schema change intact.
   *  Idempotent — safe to call on each SW wake before the first message is served. */
  async hydrate(): Promise<void> {
    const all = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const parsed = TurnSession.safeParse(value);
      if (parsed.success) this.cache.set(parsed.data.tabId, parsed.data);
      else await chrome.storage.session.remove(key);
    }
  }

  /** The cached session for a tab, or `undefined` if none has started. Synchronous hot path. */
  get(tabId: number): TurnSession | undefined {
    return this.cache.get(tabId);
  }

  /** Every live session (introspection / fan-out). */
  all(): TurnSession[] {
    return [...this.cache.values()];
  }

  /** Number of live sessions. */
  get size(): number {
    return this.cache.size;
  }

  /** Get-or-create the session for a tab. A freshly created one starts with an empty changeset
   *  whose `sessionId` (minted by the caller) keys this tab's history entry — NOT a handoff
   *  idempotency key, despite what this said before #165 S10: nothing under `src/mcp/` reads it and
   *  the dispatched task spec carries no idempotency key at all. Persisted on create. */
  async ensure(tabId: number, url: string, sessionId: string): Promise<TurnSession> {
    const existing = this.cache.get(tabId);
    if (existing) return existing;
    const created: TurnSession = {
      tabId,
      url,
      changeset: emptyChangeset(url, new Date(this.now()).toISOString(), sessionId),
      messages: [],
      usage: { steps: 0, tokens: 0 },
      status: 'idle',
      updatedAt: this.now(),
    };
    await this.persist(created);
    return created;
  }

  /** Apply a partial update to a tab's session and persist it. Throws if the tab has no session
   *  yet — callers `ensure()` first. Returns the updated session. */
  async patch(tabId: number, patch: Partial<Omit<TurnSession, 'tabId'>>): Promise<TurnSession> {
    const current = this.require(tabId);
    const next: TurnSession = { ...current, ...patch, tabId, updatedAt: this.now() };
    await this.persist(next);
    return next;
  }

  /** Append messages to a tab's turn thread. Convenience over `patch` for the common case.
   *  Applies the high-water compaction (`compactSessionThread`): append-only in the common
   *  case (prefix-cache friendly); past ~24k approx tokens the oldest turns fold into one
   *  digest message while recent turns stay verbatim — a 60-turn session stops re-sending
   *  (and re-billing) its entire history and can't grow into the storage quota. */
  async appendMessages(tabId: number, ...messages: ChatMessage[]): Promise<TurnSession> {
    const current = this.require(tabId);
    const { messages: compacted } = compactSessionThread([...current.messages, ...messages]);
    return this.patch(tabId, { messages: compacted });
  }

  /** Replace a tab's changeset (recorder output — slice 07). */
  async setChangeset(tabId: number, changeset: Changeset): Promise<TurnSession> {
    return this.patch(tabId, { changeset });
  }

  /** Forget a tab's session (turn ended / tab closed). No-op for an unknown tab. */
  async clear(tabId: number): Promise<void> {
    this.cache.delete(tabId);
    await chrome.storage.session.remove(sessionKey(tabId));
  }

  private require(tabId: number): TurnSession {
    const current = this.cache.get(tabId);
    if (!current) throw new Error(`No session for tab ${tabId}; call ensure() first`);
    return current;
  }

  private async persist(session: TurnSession): Promise<void> {
    this.cache.set(session.tabId, session);
    await chrome.storage.session.set({ [sessionKey(session.tabId)]: session });
  }
}
