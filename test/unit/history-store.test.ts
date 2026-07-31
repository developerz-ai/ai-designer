import { beforeEach, describe, expect, it } from 'vitest';
import { boundMessages, type Conversation, HistoryStore } from '@/agent/history-store';
import type { ChatMessage } from '@/agent/session';

// history-store.ts unit: the SW's cap-10 conversation ring buffer persists to (and rehydrates from)
// an in-memory chrome.storage.local fake, and size-bounds messages before they're written — no real
// extension runtime, no Date.now() (the clock is injected).

const URL = 'https://example.com/pricing';

// Minimal in-memory chrome.storage.local (MV3 promise API), exposed for assertions.
function installChromeStorageLocalFake(): Map<string, unknown> {
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
  return store;
}

let backing: Map<string, unknown>;
const at = (ms: number) => () => ms;
const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

beforeEach(() => {
  backing = installChromeStorageLocalFake();
});

describe('HistoryStore.appendTurn: new conversation', () => {
  it('creates + persists a conversation keyed by id, newest first', async () => {
    const store = new HistoryStore({ now: at(1000) });
    const conv = await store.appendTurn({
      id: 'a',
      title: 'Redesign hero',
      url: URL,
      mode: 'copy',
      messages: [msg('user', 'redesign the hero')],
    });

    expect(conv).toMatchObject({ id: 'a', title: 'Redesign hero', url: URL, createdAt: 1000 });
    expect(store.get('a')).toEqual(conv);
    expect(store.list()).toEqual([
      {
        id: 'a',
        title: 'Redesign hero',
        url: URL,
        mode: 'copy',
        createdAt: 1000,
        messageCount: 1,
        hasReport: false,
      },
    ]);
    const persisted = backing.get('history:conversations') as Conversation[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe('a');
  });

  it('extends an existing conversation in place rather than creating a new slot', async () => {
    const store = new HistoryStore({ now: at(1) });
    await store.appendTurn({ id: 'a', title: 'x', url: URL, messages: [msg('user', 'hi')] });
    const updated = await store.appendTurn({
      id: 'a',
      title: 'x',
      url: URL,
      messages: [msg('assistant', 'done')],
    });

    expect(updated.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(store.size).toBe(1); // still one conversation, not two
  });
});

describe('HistoryStore: cap-10 ring buffer', () => {
  it('evicts the oldest conversation once an 11th is appended', async () => {
    const store = new HistoryStore({ now: at(0) });
    for (let i = 0; i < 10; i++) {
      await store.appendTurn({ id: `c${i}`, title: `t${i}`, url: URL, messages: [] });
    }
    expect(store.size).toBe(10);
    expect(store.get('c0')).toBeDefined(); // oldest still present at cap

    await store.appendTurn({ id: 'c10', title: 't10', url: URL, messages: [] });

    expect(store.size).toBe(10);
    expect(store.get('c0')).toBeUndefined(); // oldest evicted
    expect(store.get('c10')).toBeDefined(); // newest present
    expect(store.list()[0]?.id).toBe('c10'); // newest first
  });

  it('updating an existing conversation does not evict anything', async () => {
    const store = new HistoryStore({ now: at(0) });
    for (let i = 0; i < 10; i++) {
      await store.appendTurn({ id: `c${i}`, title: `t${i}`, url: URL, messages: [] });
    }
    await store.appendTurn({ id: 'c0', title: 't0', url: URL, messages: [msg('user', 'more')] });

    expect(store.size).toBe(10);
    expect(store.get('c0')?.messages).toHaveLength(1);
  });
});

describe('HistoryStore: report + PR link (ship, 07/12)', () => {
  it('attaches a report as Markdown text, and a PR link, on an existing conversation', async () => {
    const store = new HistoryStore({ now: at(0) });
    await store.appendTurn({ id: 'a', title: 't', url: URL, messages: [] });

    await store.setReport('a', '# Report\n\nsummary');
    const withPr = await store.setPrLink('a', 'https://github.com/org/repo/pull/1');

    expect(withPr.report).toBe('# Report\n\nsummary');
    expect(withPr.prLink).toBe('https://github.com/org/repo/pull/1');
    expect(store.list()[0]).toMatchObject({ hasReport: true });
  });

  it('throws when setting a report/PR link on an unknown id', async () => {
    const store = new HistoryStore();
    await expect(store.setReport('missing', 'x')).rejects.toThrow(/No conversation missing/);
    await expect(store.setPrLink('missing', 'x')).rejects.toThrow(/No conversation missing/);
  });
});

describe('HistoryStore.delete', () => {
  it('removes a conversation from history; no-op for an unknown id', async () => {
    const store = new HistoryStore({ now: at(0) });
    await store.appendTurn({ id: 'a', title: 't', url: URL, messages: [] });

    await store.delete('missing'); // no-op, doesn't throw
    expect(store.size).toBe(1);

    await store.delete('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.size).toBe(0);
    expect((backing.get('history:conversations') as Conversation[]).length).toBe(0);
  });
});

describe('HistoryStore.hydrate', () => {
  it('rehydrates a persisted ring buffer into a fresh store', async () => {
    const first = new HistoryStore({ now: at(5) });
    await first.appendTurn({ id: 'a', title: 't', url: URL, messages: [msg('user', 'hi')] });

    const revived = new HistoryStore();
    expect(revived.size).toBe(0);
    await revived.hydrate();

    expect(revived.get('a')?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(revived.size).toBe(1);
  });

  it('treats a corrupt/legacy record as empty and purges it', async () => {
    backing.set('history:conversations', [{ id: 'a', url: 42 }]); // url not a string
    const store = new HistoryStore();
    await store.hydrate();
    expect(store.size).toBe(0);
    expect(backing.has('history:conversations')).toBe(false);
  });

  it('is a no-op on a fresh install', async () => {
    const store = new HistoryStore();
    await store.hydrate();
    expect(store.size).toBe(0);
  });

  it('salvages good conversations alongside a corrupt one instead of total amnesia (#168)', async () => {
    const seeded = new HistoryStore({ now: at(5) });
    await seeded.appendTurn({ id: 'good-1', title: 'one', url: URL, messages: [msg('user', 'a')] });
    await seeded.appendTurn({ id: 'good-2', title: 'two', url: URL, messages: [msg('user', 'b')] });

    // Corrupt ONE entry in place (a stale-schema record after an update).
    const raw = backing.get('history:conversations') as unknown[];
    backing.set('history:conversations', [...raw, { id: 'bad', url: 42 }]);

    const revived = new HistoryStore();
    await revived.hydrate();

    expect(revived.size).toBe(2);
    expect(revived.get('good-1')?.messages).toEqual([{ role: 'user', content: 'a' }]);
    expect(revived.get('good-2')?.messages).toEqual([{ role: 'user', content: 'b' }]);
    // The cleaned list is persisted back so the corruption never re-surfaces.
    const persisted = backing.get('history:conversations') as unknown[];
    expect(persisted).toHaveLength(2);
  });
});

describe('boundMessages: size-bounding', () => {
  it('replaces data-URL image parts with a placeholder', () => {
    const withImage: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', image: 'data:image/png;base64,'.padEnd(5000, 'A') },
      ],
    };

    const [bounded] = boundMessages([withImage]);
    const content = bounded?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('expected array content');
    const imagePart = content.find((p) => p.type === 'image') as { image: unknown };
    expect(imagePart.image).toBe('[image omitted from history]');
    expect(JSON.stringify(bounded).length).toBeLessThan(500);
  });

  it('truncates an over-long text string rather than dropping the message', () => {
    const long: ChatMessage = { role: 'assistant', content: 'x'.repeat(10_000) };
    const [bounded] = boundMessages([long]);
    expect(typeof bounded?.content).toBe('string');
    expect((bounded?.content as string).length).toBeLessThan(10_000);
  });

  it('replaces BARE-base64 image payloads (what the loop’s toModelOutput produces) with the placeholder, not a 4k truncation (#168)', () => {
    // `loop.ts` strips the `data:` prefix before handing a screenshot to the model, so the
    // persisted tool-result file part holds plain base64 — the data-URL check never fires.
    const bareBase64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(500); // ~11k chars, base64 charset only
    const toolMessage: ChatMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't1',
          toolName: 'screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'Screenshot of the current result.' },
              { type: 'file', data: { type: 'data', data: bareBase64 }, mediaType: 'image/png' },
            ],
          },
        },
      ],
    };
    const call: ChatMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'screenshot', input: {} }],
    };

    const bounded = boundMessages([call, toolMessage]);
    const flat = JSON.stringify(bounded);
    expect(bounded).toHaveLength(2);
    expect(flat).toContain('[image omitted from history]');
    expect(flat).not.toContain(bareBase64.slice(0, 100)); // no half-truncated binary junk
  });

  it('still truncates (not placeholders) ordinary long prose — the base64 heuristic never fires on real text', () => {
    const prose = `${'A meaningful sentence with spaces. '.repeat(300)}`;
    const [bounded] = boundMessages([{ role: 'assistant', content: prose }]);
    expect(typeof bounded?.content).toBe('string');
    expect(bounded?.content as string).toContain('A meaningful sentence');
    expect(bounded?.content as string).not.toContain('[image omitted from history]');
  });

  it('keeps only the most recent messages when a thread exceeds the per-conversation cap', () => {
    const messages = Array.from({ length: 250 }, (_, i) => msg('user', `turn ${i}`));
    const bounded = boundMessages(messages);
    expect(bounded).toHaveLength(200);
    expect(bounded[0]).toEqual(msg('user', 'turn 50'));
    expect(bounded.at(-1)).toEqual(msg('user', 'turn 249'));
  });
});

describe('boundMessages: coherent tool-call/tool-result units', () => {
  const assistantToolCall: ChatMessage = {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 't1', toolName: 'setStyle', input: { selector: '#x' } },
    ],
  };
  const toolResult: ChatMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 't1',
        toolName: 'setStyle',
        output: { type: 'text', value: 'ok' },
      },
    ],
  };

  it('drops a tool-result orphaned by the window slice (no preceding tool-call) rather than opening the thread with a dangling result', () => {
    // The slice can start on a `tool` message whose tool-call fell outside the window — keeping it
    // in isolation orphans the pair. A coherent bounding drops the dangling leading result.
    const bounded = boundMessages([toolResult, msg('user', 'hi')]);
    expect(bounded).toEqual([msg('user', 'hi')]);
    expect(bounded.some((m) => m.role === 'tool')).toBe(false);
  });

  it('keeps an assistant tool-call together with its answering tool-result', () => {
    const bounded = boundMessages([msg('user', 'go'), assistantToolCall, toolResult]);
    expect(bounded).toHaveLength(3);
    expect(bounded[1]).toEqual(assistantToolCall);
    expect(bounded[2]).toEqual(toolResult);
  });
});
