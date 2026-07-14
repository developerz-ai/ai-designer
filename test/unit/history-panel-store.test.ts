import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderConversationMessages } from '@/entrypoints/sidepanel/stores/history';
import type { Conversation, ConversationSummary, PanelToSw } from '@/shared/messages';

// Pure flattening: mirrors test/unit/mcp-panel-store.test.ts's split between mock-free pure
// coverage and RPC-level dispatch coverage.

const base: Conversation = {
  id: 'c1',
  title: 'Landing page copy pass',
  url: 'https://example.com/',
  mode: 'copy',
  createdAt: 1_700_000_000_000,
  messages: [],
};

describe('renderConversationMessages', () => {
  it('renders a plain string message as-is', () => {
    const conversation: Conversation = {
      ...base,
      messages: [{ role: 'user', content: 'Make the CTA button orange' }],
    };
    expect(renderConversationMessages(conversation)).toEqual([
      { role: 'user', text: 'Make the CTA button orange' },
    ]);
  });

  it('joins text parts and skips unknown/empty ones', () => {
    const conversation: Conversation = {
      ...base,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, updating the button.' },
            { type: 'reasoning', text: 'thinking…' },
          ],
        },
      ],
    };
    expect(renderConversationMessages(conversation)).toEqual([
      { role: 'assistant', text: 'Sure, updating the button.\nthinking…' },
    ]);
  });

  it('summarizes tool-call/tool-result parts instead of dumping raw args', () => {
    const conversation: Conversation = {
      ...base,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolName: 'setStyle', toolCallId: 't1', input: {} }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolName: 'setStyle',
              toolCallId: 't1',
              output: { type: 'json', value: { ok: true } },
            },
          ],
        },
      ],
    };
    expect(renderConversationMessages(conversation)).toEqual([
      { role: 'assistant', text: '→ called setStyle' },
      { role: 'tool', text: '← setStyle result' },
    ]);
  });

  it('omits image/file payloads rather than rendering a data URL', () => {
    const conversation: Conversation = {
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare against this' },
            { type: 'image', image: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    };
    expect(renderConversationMessages(conversation)).toEqual([
      { role: 'user', text: 'Compare against this\n[image omitted]' },
    ]);
  });
});

// RPC-level coverage: dispatch-only actions round-trip through chrome.runtime.sendMessage (fake,
// no real extension context), mirroring test/unit/mcp-panel-store.test.ts's pattern.
type SendMessage = (msg: PanelToSw) => unknown;

function installChromeFake(handle: SendMessage): void {
  const sendMessage = vi.fn(async (msg: unknown) => handle(msg as PanelToSw));
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

const summary: ConversationSummary = {
  id: 'c1',
  title: 'Landing page copy pass',
  url: 'https://example.com/',
  mode: 'copy',
  createdAt: 1_700_000_000_000,
  messageCount: 2,
  hasReport: true,
  prLink: undefined,
};

describe('history store actions', () => {
  it('hydrateHistory populates conversations on success', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'history-list') return { ok: true, conversations: [summary] };
      return { ok: false };
    });
    const store = await import('@/entrypoints/sidepanel/stores/history');

    await store.hydrateHistory();

    expect(store.conversations()).toEqual([summary]);
    expect(store.error()).toBeNull();
  });

  it('hydrateHistory surfaces a failure without touching the list', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: false }));
    const store = await import('@/entrypoints/sidepanel/stores/history');

    await store.hydrateHistory();

    expect(store.conversations()).toEqual([]);
    expect(store.error()).toBe('Failed to load history.');
  });

  it('openConversation sets the selected conversation; closeConversation clears it', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'history-get') return { ok: true, conversation: base };
      return { ok: false };
    });
    const store = await import('@/entrypoints/sidepanel/stores/history');

    await store.openConversation('c1');
    expect(store.selected()).toEqual(base);

    store.closeConversation();
    expect(store.selected()).toBeNull();
  });

  it('openConversation surfaces a not-found error', async () => {
    vi.resetModules();
    installChromeFake(() => ({ ok: false, error: 'No conversation c1 in history' }));
    const store = await import('@/entrypoints/sidepanel/stores/history');

    await store.openConversation('c1');

    expect(store.selected()).toBeNull();
    expect(store.error()).toBe('No conversation c1 in history');
  });

  it('deleteConversation drops the entry and closes the open replay', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'history-list') return { ok: true, conversations: [summary] };
      if (msg.type === 'history-get') return { ok: true, conversation: base };
      if (msg.type === 'history-delete') return { ok: true };
      return { ok: false };
    });
    const store = await import('@/entrypoints/sidepanel/stores/history');

    await store.hydrateHistory();
    await store.openConversation('c1');
    expect(store.conversations()).toHaveLength(1);
    expect(store.selected()).not.toBeNull();

    await store.deleteConversation('c1');

    expect(store.conversations()).toEqual([]);
    expect(store.selected()).toBeNull();
  });

  it('deleteConversation surfaces a failure and keeps the entry', async () => {
    vi.resetModules();
    installChromeFake((msg) => {
      if (msg.type === 'history-list') return { ok: true, conversations: [summary] };
      if (msg.type === 'history-delete') return { ok: false, error: 'Delete failed' };
      return { ok: false };
    });
    const store = await import('@/entrypoints/sidepanel/stores/history');

    await store.hydrateHistory();
    await store.deleteConversation('c1');

    expect(store.conversations()).toEqual([summary]);
    expect(store.error()).toBe('Delete failed');
  });
});
