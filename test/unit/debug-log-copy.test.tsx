import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogCopy } from '@/entrypoints/sidepanel/components/DebugLogCopy';

// The button exists so a QA report can carry a trace instead of "it didn't work". What has to hold
// is that a press puts the SERVICE WORKER's rendered markdown on the clipboard verbatim, and that a
// refusal is SAID rather than swallowed — a button that silently fails leaves the user pasting
// nothing and believing they pasted a log.

const MARKDOWN = '## Designer debug log\n\n- model: test\n';

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
