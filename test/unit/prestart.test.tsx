import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw, ReadinessState } from '@/shared/messages';

// The pre-Start Chat surface. Before this component the first screen after install was one dead
// sentence pointing at a Start button in the header — it told you what to do without letting you
// do it. Asserted through roles: what the user can actually press has to change with readiness.

function readiness(over: Partial<ReadinessState> = {}): ReadinessState {
  return {
    provider: 'missing',
    model: 'missing',
    apiKey: 'missing',
    hostPermission: 'needed',
    pageAccess: 'needed',
    mcp: { connected: 0, total: 0 },
    ready: false,
    ...over,
  };
}

function installChromeFake(state: ReadinessState): { sent: PanelToSw[] } {
  const sent: PanelToSw[] = [];
  const sendMessage = vi.fn(async (raw: unknown) => {
    const msg = raw as PanelToSw;
    sent.push(msg);
    if (msg.type === 'readiness') return { ok: true, state };
    return { ok: true };
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage,
      connect: () => ({
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage() {},
      }),
    },
  };
  return { sent };
}

/** Fresh module graph per spec — the readiness/session stores are module singletons. */
async function mount(onOpenSettings = vi.fn()) {
  const { PreStart } = await import('@/entrypoints/sidepanel/components/PreStart');
  const { hydrateReadiness } = await import('@/entrypoints/sidepanel/stores/readiness');
  render(() => <PreStart onOpenSettings={onOpenSettings} />);
  await hydrateReadiness();
  return { onOpenSettings };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('PreStart', () => {
  it('offers a route to Settings while setup is incomplete', async () => {
    installChromeFake(readiness());
    const { onOpenSettings } = await mount();

    const cta = await screen.findByRole('button', { name: 'Set up provider' });
    expect(screen.queryByRole('button', { name: 'Start designing' })).toBeNull();
    fireEvent.click(cta);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('offers Start itself once readiness says the agent can run', async () => {
    const { sent } = installChromeFake(
      readiness({ provider: 'ok', model: 'ok', apiKey: 'ok', ready: true }),
    );
    await mount();

    const start = await screen.findByRole('button', { name: 'Start designing' });
    expect(screen.queryByRole('button', { name: 'Set up provider' })).toBeNull();
    fireEvent.click(start);
    // Start dispatches the real session-start RPC — the same one the header toggle sends.
    await waitFor(() => expect(sent.some((m) => m.type === 'session-start')).toBe(true));
  });
});
