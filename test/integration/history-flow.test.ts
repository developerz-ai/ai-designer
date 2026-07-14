import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '@/agent/history-store';
import { runTurn } from '@/agent/loop';
import { SessionStore } from '@/agent/session';
import type { DomDispatch } from '@/agent/tools/dom';
import { ChangesetStore } from '@/changeset/store';
import { type ShipDeps, type ShipSource, ship, type TaskBackend } from '@/mcp/handoff';
import { emptyChangeset } from '@/shared/changeset';
import type { SwToPanel } from '@/shared/messages';

// Integration: the slice-08 history flow — turn-done -> history-list, ship -> PR-link update, and
// delete -> gone — driven through the REAL cooperating modules (`agent/loop.ts` runTurn,
// `changeset/store.ts` ChangesetStore, `mcp/handoff.ts` ship, `agent/history-store.ts` HistoryStore)
// wired exactly the way `background.ts`'s `handle()` does it (its `user-message` outcome handler and
// `runHandoffRoute`'s `onStatus`). background.ts itself can't be imported under Vitest — it pulls
// the WXT `#imports` virtual module (only resolves inside a WXT build) — so this reproduces the two
// wiring sites 1:1 against the real modules, mirroring test/integration/agent-loop.test.ts and
// test/integration/handoff-route.test.ts's approach for the rest of the pipeline.

const URL = 'https://example.com/pricing';
const SESSION_ID = '00000000-0000-0000-0000-0000000000aa';

// --- fakes shared across the scenarios below -----------------------------------------------------

function installChromeStorageLocalFake(): void {
  const store = new Map<string, unknown>();
  const local = {
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
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
}

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

const finish = (u: LanguageModelV4Usage): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified: 'stop', raw: 'stop' },
});

// A one-shot plain-text turn — no tool calls needed to exercise the history append path.
function textOnlyModel(text: string): LanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        finish(usage(200, 40)),
      ]),
    ],
  });
}

// Never invoked by a text-only turn — throws loudly if the loop ever reaches for the DOM.
const dispatch: DomDispatch = async () => {
  throw new Error('dispatch should not be called for a text-only turn');
};

function collectEmit() {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
}

/** Mirrors background.ts's `user-message` outcome handler: run the turn, then append it to
 *  history keyed by the changeset's sessionId — the exact wiring at background.ts:578-608. */
async function runAndPersistTurn(
  historyStore: HistoryStore,
  changesetStore: ChangesetStore,
  userText: string,
  replyText: string,
): Promise<void> {
  const { emit } = collectEmit();
  const outcome = await runTurn({
    tabId: 1,
    messages: [{ role: 'user', content: userText }],
    model: textOnlyModel(replyText),
    instructions: 'You are a design agent.',
    dispatch,
    emit,
  });
  const newMessages = outcome.text
    ? [
        { role: 'user' as const, content: userText },
        { role: 'assistant' as const, content: outcome.text },
      ]
    : [{ role: 'user' as const, content: userText }];
  await historyStore.appendTurn({
    id: changesetStore.current.sessionId,
    title: userText,
    url: changesetStore.current.url,
    mode: 'copy',
    messages: newMessages,
  });
}

beforeEach(() => {
  installChromeStorageLocalFake();
});

describe('history flow: turn-done -> history-list', () => {
  it('a completed turn appends a conversation the history-list RPC would return', async () => {
    const historyStore = new HistoryStore({ now: () => 1_700_000_000_000 });
    const changesetStore = new ChangesetStore(
      emptyChangeset(URL, '2026-07-14T00:00:00.000Z', SESSION_ID),
    );

    expect(historyStore.list()).toEqual([]); // nothing yet

    await runAndPersistTurn(historyStore, changesetStore, 'Recolor the CTA', 'Recolored it.');

    const list = historyStore.list(); // what the `history-list` RPC hands back
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: SESSION_ID,
      title: 'Recolor the CTA',
      url: URL,
      mode: 'copy',
      messageCount: 2,
      hasReport: false,
    });

    const full = historyStore.get(SESSION_ID); // what `history-get` would hand back
    expect(full?.messages).toEqual([
      { role: 'user', content: 'Recolor the CTA' },
      { role: 'assistant', content: 'Recolored it.' },
    ]);
  });

  it('a second turn in the same session extends the entry rather than forking a new one', async () => {
    const historyStore = new HistoryStore({ now: () => 1 });
    const changesetStore = new ChangesetStore(
      emptyChangeset(URL, '2026-07-14T00:00:00.000Z', SESSION_ID),
    );

    await runAndPersistTurn(historyStore, changesetStore, 'Recolor the CTA', 'Recolored it.');
    await runAndPersistTurn(historyStore, changesetStore, 'Now tighten the spacing', 'Tightened.');

    expect(historyStore.size).toBe(1);
    const list = historyStore.list();
    expect(list[0]?.messageCount).toBe(4);
    expect(list[0]?.title).toBe('Recolor the CTA'); // title set on first turn, unchanged after
  });
});

describe('history flow: ship -> PR link updates the entry', () => {
  const source: ShipSource = {
    kind: 'changeset',
    changeset: {
      ...emptyChangeset(URL, '2026-07-14T00:00:00.000Z', SESSION_ID),
      edits: [
        {
          intent: 'Recolor the CTA',
          selector: { value: '.cta', strategy: 'css-path', fragile: false },
          changes: [{ prop: 'background', before: '#fff', after: '#f97316' }],
          frameworkHints: [],
        },
      ],
    },
  };

  // A fake MCP `task` backend: create returns a queued handle, watch settles with a PR link —
  // mirrors handoff-route.test.ts's `fakeTaskTool`, adapted to the ShipDeps `TaskBackend` shape.
  function fakeBackend(): TaskBackend {
    return {
      create: async () => ({ id: 'task-1', status: { status: 'queued' } }),
      watch: async (taskId, onStatus) => {
        onStatus({
          status: 'ci_green',
          prUrl: `https://github.com/acme/storefront/pull/${taskId}`,
        });
        return { status: 'ci_green', prUrl: `https://github.com/acme/storefront/pull/${taskId}` };
      },
    };
  }

  it('a PR link surfaced on a task-status update attaches to the conversation the changeset came from', async () => {
    const historyStore = new HistoryStore({ now: () => 1 });
    await historyStore.appendTurn({
      id: SESSION_ID,
      title: 'Recolor the CTA',
      url: URL,
      messages: [],
    });
    expect(historyStore.get(SESSION_ID)?.prLink).toBeUndefined();

    // Mirrors background.ts runHandoffRoute's `ship(source, target, { onStatus })`: a `prUrl` on a
    // status update fires a best-effort `historyStore.setPrLink` keyed by the changeset's sessionId.
    const prLinkWrites: Promise<unknown>[] = [];
    const deps: ShipDeps = {
      backend: fakeBackend(),
      onStatus: (update) => {
        if (update.prUrl) prLinkWrites.push(historyStore.setPrLink(SESSION_ID, update.prUrl));
      },
    };

    const result = await ship(source, { repo: 'acme/storefront' }, deps);
    await Promise.all(prLinkWrites);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.final.prUrl).toBe('https://github.com/acme/storefront/pull/task-1');
    expect(historyStore.get(SESSION_ID)?.prLink).toBe(
      'https://github.com/acme/storefront/pull/task-1',
    );
    expect(historyStore.list()[0]).toMatchObject({
      prLink: 'https://github.com/acme/storefront/pull/task-1',
    });
  });
});

describe('history flow: delete removes the entry', () => {
  it('history-delete drops the conversation from both the cache and chrome.storage.local', async () => {
    const historyStore = new HistoryStore({ now: () => 1 });
    await historyStore.appendTurn({
      id: SESSION_ID,
      title: 'Recolor the CTA',
      url: URL,
      messages: [],
    });
    expect(historyStore.list()).toHaveLength(1);

    await historyStore.delete(SESSION_ID);

    expect(historyStore.list()).toEqual([]);
    expect(historyStore.get(SESSION_ID)).toBeUndefined();

    // Rehydrating a fresh store from the same (fake) chrome.storage.local sees it gone too — the
    // delete really persisted, not just the in-memory cache.
    const revived = new HistoryStore();
    await revived.hydrate();
    expect(revived.size).toBe(0);
  });
});

// B8: `runHandoffRoute`'s session-less fallback must reuse the tab's session id, not mint a fresh
// random one — otherwise `setReport` targets a conversation `appendTurn` never created and the brief
// silently goes unrecorded (idempotency breaks). Reproduces the resolution `background.ts` performs.
describe('handoff route: the download-report fallback changeset reuses the tab session id', () => {
  // storage.local (history) + storage.session (sessions), both needed here.
  function installBothStorageFakes(): void {
    const local = new Map<string, unknown>();
    const session = new Map<string, unknown>();
    const api = (store: Map<string, unknown>) => ({
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
    });
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: api(local), session: api(session) },
    };
  }

  it('lets a download-report brief attach to the turn history entry it belongs to', async () => {
    installBothStorageFakes();
    const tabId = 42;
    const sessions = new SessionStore({ now: () => 1000 });
    const history = new HistoryStore({ now: () => 1000 });

    // A turn ran: it ensured this tab's session and appended a history entry keyed by the session id.
    const session = await sessions.ensure(tabId, URL, SESSION_ID);
    await history.appendTurn({
      id: session.changeset.sessionId,
      title: 'Redesign',
      url: URL,
      messages: [],
    });

    // download-report resolves its changeset by RE-ensuring the tab's session (returns the SAME id),
    // NOT a fresh random-UUID changeset — so setReport targets the conversation the turn created.
    const changeset = (await sessions.ensure(tabId, URL, crypto.randomUUID())).changeset;
    expect(changeset.sessionId).toBe(SESSION_ID);
    await history.setReport(changeset.sessionId, '# Design review');

    expect(history.get(SESSION_ID)?.report).toBe('# Design review');
    expect(history.list()[0]).toMatchObject({ hasReport: true });
  });

  it('the old bug — a fresh random sessionId — targets an id appendTurn never created and throws', async () => {
    installBothStorageFakes();
    const history = new HistoryStore({ now: () => 1000 });
    await history.appendTurn({ id: SESSION_ID, title: 'Redesign', url: URL, messages: [] });

    const stray = emptyChangeset(URL, new Date(1000).toISOString(), crypto.randomUUID());
    await expect(history.setReport(stray.sessionId, '# brief')).rejects.toThrow(/No conversation/);
  });
});
