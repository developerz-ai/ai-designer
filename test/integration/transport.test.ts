import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwToPanel } from '@/shared/messages';

// Integration: the content -> SW -> panel push path. The chrome.runtime Port is
// the cross-world seam, so it is faked; relay (SW mapping) + sw-stream (panel
// receive/reconnect) are exercised together the way the real flow wires them.

const selector = { value: '[data-testid="cta"]', strategy: 'data-attr' as const, fragile: false };
const rect = { x: 1, y: 2, width: 3, height: 4 };

interface FakePort {
  name: string;
  onMessage: { addListener: (fn: (raw: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  emit: (raw: unknown) => void;
  disconnect: () => void;
}

function makePort(name: string): FakePort {
  const onMsg: Array<(raw: unknown) => void> = [];
  const onDisc: Array<() => void> = [];
  return {
    name,
    onMessage: {
      addListener: (fn) => {
        onMsg.push(fn);
      },
    },
    onDisconnect: {
      addListener: (fn) => {
        onDisc.push(fn);
      },
    },
    emit: (raw) => {
      for (const fn of onMsg) {
        fn(raw);
      }
    },
    disconnect: () => {
      for (const fn of onDisc) {
        fn();
      }
    },
  };
}

let ports: FakePort[] = [];
let connectCount = 0;
const latest = () => ports[ports.length - 1] as FakePort;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  ports = [];
  connectCount = 0;
  globalThis.chrome = {
    runtime: {
      connect: (opts: { name: string }) => {
        connectCount++;
        const p = makePort(opts.name);
        ports.push(p);
        return p as unknown as chrome.runtime.Port;
      },
    },
  } as unknown as typeof chrome;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SW -> panel transport (relay + sw-stream)', () => {
  it('relays a content element-picked through to a panel focus subscriber', async () => {
    const { relayToPanel } = await import('@/shared/relay');
    const { connectPort, subscribeToSw } = await import('@/entrypoints/sidepanel/stores/sw-stream');
    const received: SwToPanel[] = [];
    subscribeToSw((m) => received.push(m));
    connectPort();

    // The SW's job: map the content push, then post it on the panel Port.
    const out = relayToPanel({ type: 'element-picked', candidates: [selector], rect });
    if (out) latest().emit(out);

    expect(received).toEqual([{ type: 'focus', selector, rect }]);
  });

  it('drops malformed inbound messages', async () => {
    const { connectPort, subscribeToSw } = await import('@/entrypoints/sidepanel/stores/sw-stream');
    const received: SwToPanel[] = [];
    subscribeToSw((m) => received.push(m));
    connectPort();

    latest().emit({ type: 'not-a-real-type' });
    latest().emit({ nonsense: true });
    latest().emit({ type: 'focus' }); // missing selector/rect

    expect(received).toEqual([]);
  });

  it('reconnects after the SW-side Port disconnects, keeping subscribers', async () => {
    const { connectPort, subscribeToSw } = await import('@/entrypoints/sidepanel/stores/sw-stream');
    const received: SwToPanel[] = [];
    subscribeToSw((m) => received.push(m));
    connectPort();
    expect(connectCount).toBe(1);

    latest().disconnect(); // SW evicted mid-session
    expect(connectCount).toBe(1); // backoff pending, not yet reconnected
    vi.advanceTimersByTime(500);
    expect(connectCount).toBe(2); // reconnected on the fresh Port

    latest().emit({ type: 'picker-state', active: true });
    expect(received).toEqual([{ type: 'picker-state', active: true }]);
  });

  it('connectPort is idempotent', async () => {
    const { connectPort } = await import('@/entrypoints/sidepanel/stores/sw-stream');
    connectPort();
    connectPort();
    expect(connectCount).toBe(1);
  });
});
