import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogView } from '@/entrypoints/sidepanel/components/DebugLogView';
import { fetchDebugLog } from '@/entrypoints/sidepanel/stores/debug-log';

// The viewer half of the debug log (DebugLogCopy's sibling): see the trace, not just copy it
// blind. What has to hold is that the panel shows EXACTLY what the service worker rendered (one
// `debug-log-get` shape shared with the clipboard path — `stores/debug-log.ts` `fetchDebugLog`),
// that an empty log SAYS so instead of rendering a header-only document that looks like a trace,
// and that copy/refresh/close all work from inside the view. Harness mirrors
// debug-log-copy.test.tsx (fake chrome.runtime.sendMessage + clipboard).

const MARKDOWN =
  '## Designer debug log\n\n- model: test\n- entries: 12\n\n### 1. turn-start\nsetStyle .cta\n';

const HEADER_ONLY = '## Designer debug log\n\n- model: test\n- entries: 0\n';

const sendMessage = vi.fn();
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, markdown: MARKDOWN, entries: 12 });
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

describe('fetchDebugLog', () => {
  it('surfaces the SW-rendered markdown and its entry count over one debug-log-get call', async () => {
    await expect(fetchDebugLog()).resolves.toEqual({
      ok: true,
      markdown: MARKDOWN,
      entries: 12,
      empty: false,
    });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'debug-log-get' });
  });

  it('reports `empty` from the schema count, and from the header regex for a pre-count SW', async () => {
    sendMessage.mockResolvedValue({ ok: true, markdown: MARKDOWN, entries: 0 });
    await expect(fetchDebugLog()).resolves.toMatchObject({ ok: true, empty: true });

    sendMessage.mockResolvedValue({ ok: true, markdown: HEADER_ONLY }); // no `entries` field
    await expect(fetchDebugLog()).resolves.toMatchObject({
      ok: true,
      empty: true,
      entries: undefined,
    });
  });

  it('a malformed SW reply comes back ok:false, not an unhandled rejection', async () => {
    sendMessage.mockResolvedValue({ nonsense: true });
    await expect(fetchDebugLog()).resolves.toEqual({ ok: false });
  });

  it('a transport failure comes back ok:false too', async () => {
    sendMessage.mockRejectedValue(new Error('port closed'));
    await expect(fetchDebugLog()).resolves.toEqual({ ok: false });
  });
});

describe('DebugLogView', () => {
  it('is a named trigger; the dialog only exists once pressed', () => {
    render(() => <DebugLogView />);
    expect(screen.getByRole('button', { name: /view log/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens and renders the fetched markdown verbatim, with the entry count', async () => {
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('### 1. turn-start'));
    // Never reformatted: the SW's rendering is the display, byte for byte.
    expect(dialog.querySelector('pre')?.textContent).toBe(MARKDOWN);
    expect(dialog.textContent).toContain('12 entries');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'debug-log-get' });
  });

  it('copy inside the view writes the same markdown through the store copy path', async () => {
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MARKDOWN));
    // Confirmation on the control that acted, like DebugLogCopy.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
    );
  });

  it('refresh re-asks the service worker and shows the new log', async () => {
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.querySelector('pre')).not.toBeNull());

    const updated = `${MARKDOWN}### 2. turn-done\n`;
    sendMessage.mockResolvedValue({ ok: true, markdown: updated, entries: 13 });
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(dialog.querySelector('pre')?.textContent).toBe(updated));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('an empty log renders the honest empty message, not a blank box', async () => {
    sendMessage.mockResolvedValue({ ok: true, markdown: HEADER_ONLY, entries: 0 });
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toMatch(/nothing logged/i));
    expect(dialog.querySelector('pre')).toBeNull();
  });

  it('a failed fetch is said in the view, with Refresh still available', async () => {
    sendMessage.mockRejectedValue(new Error('port closed'));
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toMatch(/could not load/i));
    expect(screen.getByRole('button', { name: /refresh/i })).toBeEnabled();
  });

  it('closes from the header button', async () => {
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    render(() => <DebugLogView />);
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
