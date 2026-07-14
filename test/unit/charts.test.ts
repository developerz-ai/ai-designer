import { afterEach, describe, expect, it } from 'vitest';
import type { Bridge } from '@/dom/bridge';
import { createChartReader, extractCharts } from '@/dom/charts';

// Unit (jsdom): chart-lib data extraction (slice 15E). Chart-lib instances live on page-window globals,
// so we stub them on jsdom's window exactly as the MAIN world would see them (mirrors page-facts.test);
// SVG libs (Recharts) are read straight from the shared DOM. `createChartReader` is exercised with a
// stub bridge — the real MAIN-world round-trip lives in the integration suite.

const globals = (): Record<string, unknown> => window as unknown as Record<string, unknown>;
const added: string[] = [];
function setGlobal(key: string, value: unknown): void {
  globals()[key] = value;
  added.push(key);
}
function mount(html: string): void {
  document.body.innerHTML = html;
}
function stubBridge(request: Bridge['request']): Bridge {
  return { request, dispose: () => {} };
}

afterEach(() => {
  for (const key of added) delete globals()[key];
  added.length = 0;
  mount('');
});

describe('extractCharts — Chart.js', () => {
  it('extracts type, labels, and dataset series from Chart.instances', () => {
    mount('<canvas id="sales"></canvas>');
    const canvas = document.getElementById('sales');
    setGlobal('Chart', {
      instances: {
        0: {
          config: { type: 'bar' },
          data: { labels: ['Q1', 'Q2'], datasets: [{ label: 'Revenue', data: [10, 20] }] },
          canvas,
        },
      },
    });

    const [chart] = extractCharts(window, document);

    expect(chart?.lib).toBe('chartjs');
    expect(chart?.kind).toBe('bar');
    expect(chart?.selector).toBe('#sales');
    expect(chart?.labels).toEqual(['Q1', 'Q2']); // shared axis, hoisted off the series
    expect(chart?.series[0]).toEqual({ name: 'Revenue', values: [10, 20] });
  });
});

describe('extractCharts — ECharts', () => {
  it('extracts series + axis labels via getInstanceByDom', () => {
    mount('<div id="e" _echarts_instance_="ec_1"></div>');
    const host = document.getElementById('e');
    setGlobal('echarts', {
      getInstanceByDom: (el: Element) =>
        el === host
          ? {
              getOption: () => ({
                xAxis: [{ data: ['A', 'B'] }],
                series: [{ name: 'Load', type: 'line', data: [3, 4] }],
                title: [{ text: 'Traffic' }],
              }),
            }
          : null,
    });

    const [chart] = extractCharts(window, document);

    expect(chart?.lib).toBe('echarts');
    expect(chart?.kind).toBe('line');
    expect(chart?.title).toBe('Traffic');
    expect(chart?.labels).toEqual(['A', 'B']);
    expect(chart?.series[0]).toEqual({ name: 'Load', values: [3, 4] });
  });
});

describe('extractCharts — Highcharts', () => {
  it('extracts categories + point.y values, skipping sparse holes', () => {
    mount('<div id="h"></div>');
    const container = document.getElementById('h');
    setGlobal('Highcharts', {
      charts: [
        undefined, // a destroyed chart leaves a hole
        {
          options: { title: { text: 'Uptime' }, chart: { type: 'column' } },
          xAxis: [{ categories: ['Mon', 'Tue'] }],
          series: [{ name: 'API', type: 'column', data: [{ y: 5 }, { y: 6 }] }],
          container,
        },
      ],
    });

    const [chart] = extractCharts(window, document);

    expect(chart?.lib).toBe('highcharts');
    expect(chart?.kind).toBe('column');
    expect(chart?.title).toBe('Uptime');
    expect(chart?.labels).toEqual(['Mon', 'Tue']);
    expect(chart?.series[0]).toEqual({ name: 'API', values: [5, 6] });
  });
});

describe('extractCharts — Recharts (DOM-only)', () => {
  it('extracts series names from the legend without a page global', () => {
    mount(
      `<div class="recharts-wrapper" id="rc">
        <svg class="recharts-surface"></svg>
        <span class="recharts-legend-item-text">Sessions</span>
        <span class="recharts-legend-item-text">Bounce</span>
      </div>`,
    );

    const [chart] = extractCharts(window, document);

    expect(chart?.lib).toBe('recharts');
    expect(chart?.selector).toBe('#rc');
    expect(chart?.series.map((s) => s.name)).toEqual(['Sessions', 'Bounce']);
  });
});

describe('extractCharts — hardening', () => {
  it('returns [] on a plain page and never throws on a hostile lib shape', () => {
    mount('<main><h1>No charts here</h1></main>');
    expect(extractCharts(window, document)).toEqual([]);

    setGlobal('Chart', {
      get instances() {
        throw new Error('hostile getter');
      },
    });
    expect(extractCharts(window, document)).toEqual([]);
  });

  it('caps labels + values so a hostile dataset can not blow the token budget', () => {
    mount('<canvas id="huge"></canvas>');
    const canvas = document.getElementById('huge');
    const big = Array.from({ length: 5000 }, (_, i) => i);
    setGlobal('Chart', {
      instances: {
        0: {
          config: { type: 'line' },
          data: { labels: big.map(String), datasets: [{ label: 'X', data: big }] },
          canvas,
        },
      },
    });

    const [chart] = extractCharts(window, document);

    expect(chart?.labels?.length).toBeLessThanOrEqual(500);
    expect(chart?.series[0]?.values.length).toBeLessThanOrEqual(500);
  });
});

describe('createChartReader', () => {
  it('returns extracted data from the MAIN-world bridge probe', async () => {
    const reader = createChartReader({
      bridge: stubBridge(async () => ({
        charts: [{ lib: 'chartjs', kind: 'line', series: [{ values: [1, 2, 3] }] }],
      })),
    });

    const read = await reader.read();

    expect(read.source).toBe('data');
    expect(read.charts[0]?.series[0]?.values).toEqual([1, 2, 3]);
  });

  it('falls back to a DOM-only pass when the bridge is unreachable', async () => {
    mount(
      `<div class="recharts-wrapper"><span class="recharts-legend-item-text">Revenue</span></div>`,
    );
    const reader = createChartReader({
      bridge: stubBridge(() => Promise.reject(new Error('no MAIN world'))),
    });

    const read = await reader.read();

    expect(read.source).toBe('data');
    expect(read.charts[0]?.lib).toBe('recharts');
  });

  it('falls back to vision targets when no data is reachable', async () => {
    mount('<canvas></canvas>');
    const reader = createChartReader({
      bridge: stubBridge(() => Promise.reject(new Error('no MAIN world'))),
    });

    const read = await reader.read();

    expect(read.source).toBe('vision');
    expect(read.targets).toContain('canvas');
    expect(read.reason).toBeTruthy();
  });

  it('reads an HTML tooltip that appears on hover', async () => {
    mount('<div id="chart"></div><div class="chartjs-tooltip"></div>');
    const tip = document.querySelector('.chartjs-tooltip') as HTMLElement;
    document
      .getElementById('chart')
      ?.addEventListener('mouseover', () => (tip.textContent = 'Jan: 42'));
    const reader = createChartReader({
      bridge: stubBridge(() => Promise.reject(new Error('n/a'))),
    });

    const result = await reader.readTooltip('#chart');

    expect(result).toEqual({ text: 'Jan: 42' });
  });
});
