import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogCopy } from '@/entrypoints/sidepanel/components/DebugLogCopy';
import { logHasNoEntries } from '@/entrypoints/sidepanel/stores/debug-log';

// The button exists so a QA report can carry a trace instead of "it didn't work". What has to hold
// is that a press puts the SERVICE WORKER's rendered markdown on the clipboard verbatim, and that a
// refusal is SAID rather than swallowed — a button that silently fails leaves the user pasting
// nothing and believing they pasted a log.

const MARKDOWN = '## Designer debug log\n\n- model: test\n- entries: 12\n\n### 1. turn-start\n';

// What `renderTurnLog` emits for a tab that has logged nothing: the header alone. It copies
// "successfully" and pastes nothing — the SW states the count in its own header.
const HEADER_ONLY = '## Designer debug log\n\n- model: test\n- entries: 0\n';

const sendMessage = vi.fn();
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, markdown: MARKDOWN });
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  // jsdom ships no clipboard; define it rather than spy on a missing property.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

describe('DebugLogCopy', () => {
  it('is a named control, reachable by its accessible name', () => {
    render(() => <DebugLogCopy />);
    expect(screen.getByRole('button', { name: /copy debug log/i })).toBeInTheDocument();
  });

  it('asks the service worker and writes exactly what it returned', async () => {
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MARKDOWN));
    // Rendering happens SW-side; the panel must not reformat what it pastes.
    expect(sendMessage).toHaveBeenCalledWith({ type: 'debug-log-get' });
  });

  it('confirms on the label itself, so the control that acted is the one that reports', async () => {
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
    );
  });

  it('says so when the log has no entries yet, instead of a bare "Copied"', async () => {
    // No `entries` on the reply (a pre-count SW): detection falls back to the header regex.
    sendMessage.mockResolvedValue({ ok: true, markdown: HEADER_ONLY });
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /logged nothing yet/i })).toBeInTheDocument(),
    );
    // Still written: the header names the tab, model and provider — worth pasting.
    expect(writeText).toHaveBeenCalledWith(HEADER_ONLY);
  });

  it("prefers the reply's own `entries` count over parsing the markdown", async () => {
    // entries: 0 with markdown that does NOT read as header-only — the schema count wins, so this
    // still reports empty. (The count is post-merge truth; the regex is a fallback for old SWs.)
    sendMessage.mockResolvedValue({
      ok: true,
      entries: 0,
      markdown: '## Designer debug log\n\nno entries header line here\n',
    });
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /logged nothing yet/i })).toBeInTheDocument(),
    );
  });

  it('a real `entries` count reads as copied even when the markdown header says 0', async () => {
    sendMessage.mockResolvedValue({ ok: true, entries: 12, markdown: HEADER_ONLY });
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /copied — paste it into your report/i }),
      ).toBeInTheDocument(),
    );
  });

  it('SAYS a refused clipboard write failed instead of claiming success', async () => {
    writeText.mockRejectedValue(new Error('Document is not focused'));
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /could not copy/i })).toBeInTheDocument(),
    );
  });

  it('reports a malformed service-worker reply as a failure, not an unhandled rejection', async () => {
    sendMessage.mockResolvedValue({ nonsense: true });
    render(() => <DebugLogCopy />);
    fireEvent.click(screen.getByRole('button', { name: /copy debug log/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /could not copy/i })).toBeInTheDocument(),
    );
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('logHasNoEntries', () => {
  it('reads the SW header count — `- entries: 0` is empty, a real count is not', () => {
    expect(logHasNoEntries(HEADER_ONLY)).toBe(true);
    expect(logHasNoEntries('## Designer debug log\n\n- entries: 3\n')).toBe(false);
  });

  it('a countless blank document is empty', () => {
    expect(logHasNoEntries('')).toBe(true);
    expect(logHasNoEntries('   \n\n  ')).toBe(true);
  });

  it('a real log is not empty', () => {
    expect(logHasNoEntries(MARKDOWN)).toBe(false);
    // Countless but carrying content (an older SW without the header line): trust the content.
    expect(logHasNoEntries('## Designer debug log\n\n### 1. turn-start\n')).toBe(false);
  });
});

// LAST on purpose: keying the chat store to a tab is module state that would leak `tabId` into the
// earlier tests' dispatch assertions.
describe('copyDebugLog conversation pinning', () => {
  it('pins the request to the conversation tab the panel is keyed to', async () => {
    sendMessage.mockImplementation(async (msg: { type: string }) => {
      if (msg.type === 'session-get') {
        return { ok: true, state: 'idle', turnRunning: false, tabId: 7 };
      }
      if (msg.type === 'thread-get') return { ok: true, tabId: 7, thread: [] };
      return { ok: true, markdown: MARKDOWN, entries: 12 };
    });
    // Key the chat store's view to tab 7 — the conversation this panel is showing.
    const chat = await import('@/entrypoints/sidepanel/stores/chat');
    await chat.hydrateThread();
    expect(chat.viewTabId()).toBe(7);

    const { copyDebugLog } = await import('@/entrypoints/sidepanel/stores/debug-log');
    await expect(copyDebugLog()).resolves.toBe('copied');

    // The trace asked for is the conversation on screen, not whatever tab the SW judges current.
    expect(sendMessage).toHaveBeenCalledWith({ type: 'debug-log-get', tabId: 7 });
  });
});
