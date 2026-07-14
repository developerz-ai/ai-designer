import { afterEach, describe, expect, it } from 'vitest';
import { createBridge, serveBridge } from '@/dom/bridge';
import { createChartReader, extractCharts } from '@/dom/charts';

// Integration: the `chart-data` MAIN-world flow end to end (slice 15E) — the real bridge client + server
// (src/dom/bridge.ts) over a controllable same-window message bus, plus the content-side chart reader.
// Mirrors page-facts-bridge.test.ts's "real dispatch, faked bus" pattern: the fake window echoes
// `window.postMessage` (same-window, async, our own origin) so the server extracts from a mock Chart.js
// global and the client reader receives the series — the cross-world path we can't run without a loaded
// extension. A missing MAIN world (bridge timeout) exercises the reader's vision fallback.

type Listener = (event: MessageEvent) => void;
type Handle = ReturnType<typeof setTimeout>;

function makeWindow(origin = 'https://charts.example'): {
  win: Window;
  extras: Record<string, unknown>;
} {
  const listeners = new Set<Listener>();
  const extras: Record<string, unknown> = {};
  const base = {
    location: { origin, href: `${origin}/dashboard` },
    addEventListener(type: string, fn: Listener): void {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener(type: string, fn: Listener): void {
      if (type === 'message') listeners.delete(fn);
    },
    postMessage(data: unknown): void {
      queueMicrotask(() => {
        const event = { data, origin, source: win } as unknown as MessageEvent;
        for (const fn of [...listeners]) fn(event);
      });
    },
  };
  // A Proxy lets the extractor read page globals (`win.Chart`) off the same object that hosts the bus.
  const win = new Proxy(base, {
    get: (target, prop: string) =>
      prop in target ? (target as Record<string, unknown>)[prop] : extras[prop],
  }) as unknown as Window;
  return { win, extras };
}

function manualTimer(): {
  setTimer: (fn: () => void) => Handle;
  clearTimer: () => void;
  fire: () => void;
} {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn): Handle => {
      pending = fn;
      return 0 as unknown as Handle;
    },
    clearTimer: (): void => {
      pending = null;
    },
    fire: (): void => pending?.(),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('chart-data bridge — round-trip', () => {
  it('extracts Chart.js series in the MAIN server and delivers them to the reader', async () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'revenue';
    document.body.appendChild(canvas);

    const { win, extras } = makeWindow();
    extras.Chart = {
      instances: {
        0: {
          config: { type: 'line' },
          data: { labels: ['Jan', 'Feb'], datasets: [{ label: 'MRR', data: [100, 200] }] },
          canvas,
        },
      },
    };

    const server = serveBridge(
      { 'chart-data': () => ({ charts: extractCharts(win, document) }) },
      { win },
    );
    const bridge = createBridge({ win });
    const reader = createChartReader({ bridge, win, doc: document });

    const read = await reader.read();

    expect(read.source).toBe('data');
    expect(read.charts[0]?.lib).toBe('chartjs');
    expect(read.charts[0]?.selector).toBe('#revenue');
    expect(read.charts[0]?.labels).toEqual(['Jan', 'Feb']);
    expect(read.charts[0]?.series[0]).toEqual({ name: 'MRR', values: [100, 200] });

    bridge.dispose();
    server.dispose();
  });

  it('falls back to vision when no MAIN world answers the probe', async () => {
    document.body.innerHTML = '<canvas></canvas>';
    const { win } = makeWindow();
    const timer = manualTimer();
    const bridge = createBridge({ win, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    const reader = createChartReader({ bridge, win, doc: document });

    const pending = reader.read();
    await Promise.resolve(); // let the request register its pending nonce + timer
    timer.fire(); // no server -> the probe times out, reader falls through
    const read = await pending;

    expect(read.source).toBe('vision');
    expect(read.targets).toContain('canvas');

    bridge.dispose();
  });
});
