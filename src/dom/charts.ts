import type { Bridge } from '@/dom/bridge';
import { queryAll, queryOne } from '@/dom/read';
import { pickUnique, resolveShadowSelector } from '@/dom/selector';
import { type ChartData, ChartDataResult, ChartRead, type ChartSeries } from '@/shared/messages';

// Chart reading (slice 15E) — real charts drawn on <canvas>/WebGL have no element-per-datum, so the
// agent can't read them with DOM tools. Two paths, richest first:
//   1. DATA PROBE — detect the chart lib (Chart.js/ECharts/Highcharts/D3/Recharts) and pull its series
//      straight from the lib's own instances. Instances live in the page's MAIN world, so this runs in
//      `src/entrypoints/injected.content.ts` (the ONLY world that sees page globals) and answers the
//      isolated content world's `chart-data` bridge request. SVG libs (Recharts) are also readable from
//      the content world's shared DOM, so `extractCharts` doubles as a DOM-only fallback there.
//   2. VISION — nothing reachable (canvas/WebGL/closed lib): name the host selectors so the agent
//      screenshots + describes them (slice 13/14). Plus a tooltip-hover read for HTML-tooltip charts.
// `extractCharts` is pure (globals off `win`, DOM off `doc`) + defensive (a hostile/odd shape yields
// [], never a throw) + bounded, so it's fully jsdom-testable and can't blow the token budget. Read-only
// throughout: the MAIN world is the page's own, untrusted world — no secret is ever read or returned.

const MAX_CHARTS = 12;
const MAX_SERIES = 24;
const MAX_POINTS = 500;

// Likely chart host containers, in rough specificity order — the vision fallback screenshots whichever
// match, and the content-world tooltip read hovers them.
const HOST_SELECTORS = [
  '[_echarts_instance_]',
  '.highcharts-container',
  '.recharts-surface',
  '.apexcharts-canvas',
  '.js-plotly-plot',
  '.chartjs-render-monitor',
  'canvas',
  'svg[class*="chart" i]',
];

// --- shared value coercion (bounded, defensive) ---------------------------

function readGlobal(win: Window, path: string): unknown {
  try {
    let current: unknown = win;
    for (const key of path.split('.')) {
      if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  } catch {
    return undefined;
  }
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, cap = 200): string {
  if (typeof value === 'string') return value.slice(0, cap);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

// Coerce a datum to a finite number or null (a gap): a bare number, a numeric string, or the common
// value-bearing key of a {x,y}/{value}/… point object.
function numify(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return value.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['y', 'value', 'v', 'count', 'total']) {
      const n = o[key];
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
  }
  return null;
}

function values(list: unknown): (number | null)[] {
  return arr(list).slice(0, MAX_POINTS).map(numify);
}

function labels(list: unknown): string[] | undefined {
  const out = arr(list)
    .slice(0, MAX_POINTS)
    .map((l) => str(l, 160));
  return out.length > 0 ? out : undefined;
}

// A stable CSS locator for a chart host element (canvas/svg/div), reusing the slice-15 selector engine.
function hostSelector(el: unknown, doc: Document): string | undefined {
  if (!(el instanceof Element)) return undefined;
  try {
    return pickUnique(el, doc).value;
  } catch {
    return el.tagName.toLowerCase();
  }
}

function optional(text: string): string | undefined {
  return text !== '' ? text : undefined;
}

// --- per-lib extraction ---------------------------------------------------

function collectChartJsInstances(doc: Document, Chart: unknown): unknown[] {
  const registry = rec(Chart).instances;
  if (registry && typeof registry === 'object') return Object.values(registry as object);
  const getChart = rec(Chart).getChart;
  if (typeof getChart !== 'function') return [];
  const found: unknown[] = [];
  for (const canvas of queryAll(doc, 'canvas').slice(0, MAX_CHARTS)) {
    try {
      const inst = (getChart as (c: Element) => unknown).call(Chart, canvas);
      if (inst) found.push(inst);
    } catch {
      // getChart on a non-chart canvas can throw — skip it.
    }
  }
  return found;
}

function extractChartJs(win: Window, doc: Document): ChartData[] {
  const Chart = readGlobal(win, 'Chart');
  if (!Chart) return [];
  return collectChartJsInstances(doc, Chart)
    .slice(0, MAX_CHARTS)
    .map((inst) => {
      const config = rec(rec(inst).config);
      const data = rec(rec(inst).data ?? config.data);
      const xLabels = labels(data.labels);
      const datasets = arr(data.datasets).slice(0, MAX_SERIES);
      const series: ChartSeries[] = datasets.map((ds) => ({
        ...(optional(str(rec(ds).label)) ? { name: str(rec(ds).label) } : {}),
        values: values(rec(ds).data),
      }));
      const canvas = rec(inst).canvas ?? rec(rec(inst).ctx).canvas;
      const selector = hostSelector(canvas, doc);
      return {
        lib: 'chartjs',
        ...(optional(str(config.type)) ? { kind: str(config.type, 40) } : {}),
        ...(selector ? { selector } : {}),
        ...(xLabels ? { labels: xLabels } : {}),
        series,
      };
    });
}

function extractECharts(win: Window, doc: Document): ChartData[] {
  const echarts = readGlobal(win, 'echarts');
  const getInstanceByDom = rec(echarts).getInstanceByDom;
  if (typeof getInstanceByDom !== 'function') return [];
  const out: ChartData[] = [];
  for (const host of queryAll(doc, '[_echarts_instance_]').slice(0, MAX_CHARTS)) {
    const inst = (getInstanceByDom as (el: Element) => unknown).call(echarts, host);
    const getOption = rec(inst).getOption;
    if (typeof getOption !== 'function') continue;
    const option = rec((getOption as () => unknown).call(inst));
    const xLabels = labels(rec(arr(option.xAxis)[0]).data);
    const seriesArr = arr(option.series).slice(0, MAX_SERIES);
    const series: ChartSeries[] = seriesArr.map((s) => ({
      ...(optional(str(rec(s).name)) ? { name: str(rec(s).name) } : {}),
      values: values(rec(s).data),
    }));
    const selector = hostSelector(host, doc);
    out.push({
      lib: 'echarts',
      ...(optional(str(rec(arr(option.series)[0]).type))
        ? { kind: str(rec(arr(option.series)[0]).type, 40) }
        : {}),
      ...(optional(str(rec(arr(option.title)[0]).text))
        ? { title: str(rec(arr(option.title)[0]).text) }
        : {}),
      ...(selector ? { selector } : {}),
      ...(xLabels ? { labels: xLabels } : {}),
      series,
    });
  }
  return out;
}

function extractHighcharts(win: Window, doc: Document): ChartData[] {
  const Highcharts = readGlobal(win, 'Highcharts');
  const charts = arr(rec(Highcharts).charts).filter(Boolean); // Highcharts.charts is sparse
  return charts.slice(0, MAX_CHARTS).map((ch) => {
    const options = rec(rec(ch).options);
    const firstAxis = Array.isArray(rec(ch).xAxis) ? arr(rec(ch).xAxis)[0] : rec(ch).xAxis;
    const cats = labels(rec(firstAxis).categories);
    const seriesArr = arr(rec(ch).series).slice(0, MAX_SERIES);
    const series: ChartSeries[] = seriesArr.map((s) => {
      const points = arr(rec(s).data ?? rec(s).points).slice(0, MAX_POINTS);
      return {
        ...(optional(str(rec(s).name)) ? { name: str(rec(s).name) } : {}),
        values: points.map((p) => numify(rec(p).y ?? p)),
      };
    });
    const kind = str(rec(seriesArr[0]).type ?? rec(options.chart).type, 40);
    const title = str(rec(options.title).text);
    const selector = hostSelector(rec(ch).container ?? rec(ch).renderTo, doc);
    return {
      lib: 'highcharts',
      ...(optional(kind) ? { kind } : {}),
      ...(optional(title) ? { title } : {}),
      ...(selector ? { selector } : {}),
      ...(cats ? { labels: cats } : {}),
      series,
    };
  });
}

function extractRecharts(_win: Window, doc: Document): ChartData[] {
  // Recharts renders SVG with no JS instance; its series names live in the legend. Values aren't in
  // stable DOM attrs, so emit names only — the agent reads the values via vision/DOM. Skip a chart
  // with no legend (nothing worth surfacing over the vision fallback).
  return queryAll(doc, '.recharts-wrapper')
    .slice(0, MAX_CHARTS)
    .map((wrapper) => {
      const names = queryAll(wrapper, '.recharts-legend-item-text')
        .slice(0, MAX_SERIES)
        .map((n) => str(n.textContent, 160))
        .filter((n) => n !== '');
      if (names.length === 0) return null;
      const selector = hostSelector(wrapper, doc);
      const series: ChartSeries[] = names.map((name) => ({ name, values: [] }));
      return { lib: 'recharts', ...(selector ? { selector } : {}), series };
    })
    .filter((c): c is ChartData => c !== null);
}

function boundDatum(el: Element): unknown {
  return (el as unknown as { __data__?: unknown }).__data__;
}

function extractD3(win: Window, doc: Document): ChartData[] {
  if (!readGlobal(win, 'd3')) return []; // only attempt when D3 is actually present
  const out: ChartData[] = [];
  for (const svg of queryAll(doc, 'svg').slice(0, MAX_CHARTS)) {
    const nums: (number | null)[] = [];
    const bound = boundDatum(svg);
    if (Array.isArray(bound)) {
      for (const d of bound.slice(0, MAX_POINTS)) nums.push(numify(d));
    } else {
      for (const child of queryAll(svg, '*').slice(0, MAX_POINTS)) {
        const d = boundDatum(child);
        if (d !== undefined) nums.push(numify(d));
      }
    }
    const finite = nums.filter((n): n is number => n !== null);
    if (finite.length === 0) continue;
    const selector = hostSelector(svg, doc);
    out.push({ lib: 'd3', ...(selector ? { selector } : {}), series: [{ values: finite }] });
  }
  return out;
}

function safe(fn: () => ChartData[]): ChartData[] {
  try {
    return fn();
  } catch {
    return []; // a hostile/unexpected lib shape never breaks the whole probe
  }
}

/**
 * Extract every reachable chart's data — the MAIN-world data probe (also a content-world DOM-only
 * fallback for SVG libs). Pure, defensive, bounded: globals off `win`, DOM off `doc`; each lib's
 * extractor is isolated so one throwing lib can't sink the rest; caps keep the payload small.
 */
export function extractCharts(win: Window, doc: Document): ChartData[] {
  return [
    ...safe(() => extractChartJs(win, doc)),
    ...safe(() => extractECharts(win, doc)),
    ...safe(() => extractHighcharts(win, doc)),
    ...safe(() => extractRecharts(win, doc)),
    ...safe(() => extractD3(win, doc)),
  ].slice(0, MAX_CHARTS);
}

// --- content-side reader --------------------------------------------------

export interface ChartReaderDeps {
  /** The MAIN-world bridge client (`src/dom/bridge.ts`) for the rich data probe. */
  readonly bridge: Bridge;
  readonly win?: Window;
  readonly doc?: Document;
}

export interface ChartReader {
  /** Read charts: MAIN-world data probe first, then a DOM-only pass, else a vision-fallback plan
   *  naming the host selectors to screenshot. `selector` (optional) scopes the vision fallback. */
  read(selector?: string): Promise<ChartRead>;
  /** Hover a chart host + return any HTML tooltip DOM that appears (values without pixel-reading). */
  readTooltip(selector: string): Promise<{ text: string } | null>;
}

function findChartHosts(doc: Document): string[] {
  const out: string[] = [];
  for (const selector of HOST_SELECTORS) {
    if (queryAll(doc, selector).length > 0) out.push(selector);
  }
  return out.slice(0, MAX_CHARTS);
}

function findTooltip(doc: Document): Element | null {
  const candidates = queryAll(
    doc,
    '[role="tooltip"], .chartjs-tooltip, .echarts-tooltip, .highcharts-tooltip, [class*="tooltip" i]',
  );
  return candidates.find((el) => (el.textContent ?? '').trim() !== '') ?? null;
}

export function createChartReader(deps: ChartReaderDeps): ChartReader {
  const win = deps.win ?? window;
  const doc = deps.doc ?? document;

  const probe = async (): Promise<ChartData[]> => {
    try {
      const raw = await deps.bridge.request('chart-data');
      const parsed = ChartDataResult.safeParse(raw);
      if (parsed.success) return parsed.data.charts;
    } catch {
      // No MAIN world / malformed reply — fall through to the DOM-only pass.
    }
    return [];
  };

  const read = async (selector?: string): Promise<ChartRead> => {
    let charts = await probe();
    if (charts.length === 0) charts = extractCharts(win, doc); // DOM-only (catches SVG libs)
    if (charts.length > 0) return ChartRead.parse({ source: 'data', charts });
    const targets = selector ? [selector] : findChartHosts(doc);
    return ChartRead.parse({
      source: 'vision',
      targets,
      reason: 'No chart-lib data reachable — read via screenshot + describe.',
    });
  };

  const readTooltip = async (selector: string): Promise<{ text: string } | null> => {
    const host = selector.includes('>>>')
      ? resolveShadowSelector(doc, selector)
      : queryOne(doc, selector);
    if (!host) return null;
    host.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
    await Promise.resolve(); // let a synchronous tooltip render settle
    const tip = findTooltip(doc);
    return tip ? { text: str(tip.textContent, 500) } : null;
  };

  return { read, readTooltip };
}
