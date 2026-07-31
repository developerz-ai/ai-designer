import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { AuthDialog } from '@/entrypoints/sidepanel/components/AuthDialog';
import type { McpServer } from '@/shared/messages';

// `role="dialog" aria-modal="true"` is a PROMISE to assistive tech: everything outside is inert.
// AuthDialog made it while moving no focus, trapping none, and answering no Escape — so focus
// stayed on the McpPanel button behind it and Tab walked into content ARIA had declared silent.
// This is the one panel screen where a credential is typed. `Onboarding.tsx` already implements the
// contract; these assert the same one, through roles and keyboard behavior only.

const server: McpServer = {
  id: 'ai-dev',
  label: 'ai-dev',
  url: 'https://mcp.example.com/sse',
  transport: 'http',
  authKind: 'apikey',
  enabled: true,
  status: 'disconnected',
  toolCount: 0,
  tools: [],
  writeTools: [],
  grantedTools: [],
};

/** Mount the dialog the way McpPanel does: from a button the user pressed, which is where focus
 *  has to return when the dialog closes. */
function renderFromInvoker(onClose = vi.fn()): {
  invoker: HTMLElement;
  dialog: () => HTMLElement;
  onClose: ReturnType<typeof vi.fn>;
  close: () => void;
} {
  const [open, setOpen] = createSignal(false);
  render(() => (
    <>
      <button type="button">Authorize</button>
      <Show when={open()}>
        <AuthDialog
          server={server}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      </Show>
    </>
  ));
  const invoker = screen.getByRole('button', { name: 'Authorize' });
  invoker.focus();
  setOpen(true);
  return {
    invoker,
    dialog: () => screen.getByRole('dialog', { name: 'Authorize ai-dev' }),
    onClose,
    close: () => setOpen(false),
  };
}

describe('AuthDialog modal contract', () => {
  it('moves focus into the dialog on open', () => {
    const { dialog } = renderFromInvoker();
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
  });

  it('Escape closes it', () => {
    const { dialog, onClose } = renderFromInvoker();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab cycles within the dialog instead of leaving for inert content', () => {
    const { dialog, invoker } = renderFromInvoker();
    const ring = [
      ...dialog().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    ];
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) throw new Error('dialog has no focusable content');

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(invoker);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the button that opened it', () => {
    const { invoker, close } = renderFromInvoker();
    expect(document.activeElement).not.toBe(invoker);

    close();

    expect(document.activeElement).toBe(invoker);
  });
});
