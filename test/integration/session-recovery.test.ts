import { beforeEach, describe, expect, it } from 'vitest';
import { groundUserText } from '@/agent/focus-context';
import { SessionStore } from '@/agent/session';
import {
  readSessionLifecycle,
  reconcileTurnStatus,
  writeSessionLifecycle,
} from '@/agent/session-lifecycle';
import {
  PanelToSw,
  SessionStateResult,
  type StableSelector,
  type SwToPanel,
} from '@/shared/messages';

// Integration (#165 S5 + S6): a panel that reconnects to a service worker woken AFTER a mid-turn
// eviction gets a truthful answer, and a picked element actually reaches the turn.
//
// S5 — the turn stalls without stream traffic, Chrome kills the worker, the panel reconnects. The
// woken worker's module-level tri-state is `idle`, it pushes nothing, and the panel has no way to
// ask: the in-flight assistant bubble (closed only by `turn-done` / `error` / a non-running
// `session-state`) spins forever.
// S6 — the picker relayed a selector to the panel for DISPLAY only; nothing carried it back, so
// "make this 20% bigger" reached the SW as text alone.
//
// background.ts can't be imported under Vitest (WXT `#imports`), so its `session-get` case, its
// port-connect push, and its `user-message` grounding are reproduced 1:1 against the REAL modules —
// the same pattern as history-flow.test.ts / readiness.test.ts.

const URL = 'https://example.com/pricing';
const TAB = 7;
// A well-formed v4 UUID — `Changeset.sessionId` validates as one, and a session whose id fails
// that check is DROPPED by `SessionStore.hydrate()`, silently defeating the rehydration this pins.
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function installChromeStorageSessionFake(): void {
  const store = new Map<string, unknown>();
  const session = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items))
        store.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { session } };
}

/**
 * One service-worker lifetime. A fresh instance is a WOKEN worker: nothing in memory, only what the
 * previous one persisted to `chrome.storage.session`.
 */
async function bootWorker() {
  const sessions = new SessionStore();
  await sessions.hydrate();
  let sessionState = await readSessionLifecycle();
  let turnAbort: AbortController | null = null;
  const pushed: SwToPanel[] = [];

  const setSessionState = async (next: 'idle' | 'running' | 'stopped'): Promise<void> => {
    sessionState = next;
    await writeSessionLifecycle(next);
    pushed.push({ type: 'session-state', state: next, turnRunning: turnAbort !== null });
  };

  return {
    sessions,
    pushed,
    /** The panel port connecting — background.ts's `chrome.runtime.onConnect` push. */
    onPanelConnect(): SwToPanel {
      const msg: SwToPanel = {
        type: 'session-state',
        state: sessionState,
        turnRunning: turnAbort !== null,
      };
      pushed.push(msg);
      return msg;
    },
    /** The `session-get` RPC case, including the heal-on-read. */
    async sessionGet(): Promise<SessionStateResult> {
      const turnRunning = turnAbort !== null;
      const current = sessions.get(TAB);
      const healed = reconcileTurnStatus(current?.status, turnRunning);
      if (current && current.status !== healed) await sessions.patch(TAB, { status: healed });
      return { ok: true, state: sessionState, turnRunning, tabId: TAB };
    },
    /** The `user-message` case's opening moves: ground the text, thread it, mark the turn live. */
    async startTurn(text: string, selector?: StableSelector): Promise<string> {
      turnAbort = new AbortController();
      await sessions.ensure(TAB, URL, SESSION_ID);
      const grounded = groundUserText(text, selector);
      await sessions.appendMessages(TAB, { role: 'user', content: grounded });
      await sessions.patch(TAB, { status: 'running' });
      return grounded;
    },
    async startSession(): Promise<void> {
      await setSessionState('running');
    },
  };
}

beforeEach(() => {
  installChromeStorageSessionFake();
});

describe('integration: a panel reconnecting to a woken worker (#165 S5)', () => {
  it('learns the session is still open — not `idle` as a cold worker would claim', async () => {
    const first = await bootWorker();
    await first.startSession();
    await first.startTurn('audit the checkout flow');

    // …Chrome evicts the worker mid-turn. A brand-new worker boots on the panel's reconnect.
    const woken = await bootWorker();
    const push = woken.onPanelConnect();

    expect(push).toEqual({ type: 'session-state', state: 'running', turnRunning: false });
  });

  it('reports turnRunning:false so the orphaned in-flight bubble can be closed', async () => {
    const first = await bootWorker();
    await first.startSession();
    await first.startTurn('audit the checkout flow');
    expect(first.sessions.get(TAB)?.status).toBe('running');

    const woken = await bootWorker();
    const state = await woken.sessionGet();

    expect(SessionStateResult.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({ ok: true, state: 'running', turnRunning: false, tabId: TAB });
  });

  it('heals the per-tab turn status to stopped, so a second ask agrees with the first', async () => {
    const first = await bootWorker();
    await first.startSession();
    await first.startTurn('audit the checkout flow');

    const woken = await bootWorker();
    await woken.sessionGet();

    expect(woken.sessions.get(TAB)?.status).toBe('stopped');
    const again = await bootWorker();
    expect((await again.sessionGet()).turnRunning).toBe(false);
    expect(again.sessions.get(TAB)?.status).toBe('stopped');
  });

  it('still reports a genuinely live turn as running within one worker lifetime', async () => {
    const worker = await bootWorker();
    await worker.startSession();
    await worker.startTurn('audit the checkout flow');

    expect(await worker.sessionGet()).toMatchObject({ turnRunning: true, state: 'running' });
    expect(worker.sessions.get(TAB)?.status).toBe('running');
  });

  it('session-get is a valid PanelToSw variant the panel can actually send', () => {
    expect(PanelToSw.safeParse({ type: 'session-get' }).success).toBe(true);
  });
});

describe('integration: the picked element reaches the turn (#165 S6)', () => {
  const cta: StableSelector = { value: '.hero__cta', strategy: 'data-attr', fragile: false };

  it('grounds "this" in the persisted thread, so a resumed turn still knows the referent', async () => {
    const worker = await bootWorker();
    await worker.startTurn('make this 20% bigger', cta);

    const threaded = worker.sessions.get(TAB)?.messages.at(-1)?.content;
    expect(String(threaded)).toContain('.hero__cta');
    expect(String(threaded)).toContain('make this 20% bigger');

    // The grounding is durable: a woken worker resumes the thread WITH the referent.
    const woken = await bootWorker();
    expect(String(woken.sessions.get(TAB)?.messages.at(-1)?.content)).toContain('.hero__cta');
  });

  it('leaves an unpicked instruction exactly as the user typed it', async () => {
    const worker = await bootWorker();
    const grounded = await worker.startTurn('make the CTA orange');
    expect(grounded).toBe('make the CTA orange');
  });

  it('carries the selector across the bus schema unchanged', () => {
    const parsed = PanelToSw.safeParse({
      type: 'user-message',
      text: 'make this 20% bigger',
      selector: cta,
    });
    expect(parsed.success && parsed.data).toMatchObject({ selector: cta });
  });
});
