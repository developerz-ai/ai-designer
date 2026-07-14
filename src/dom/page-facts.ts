import type { Bridge } from '@/dom/bridge';
import { PageFacts } from '@/shared/messages';

// Detect the page's runtime stack (frameworks, chart libs, notable libraries) and cache it per URL
// for the content world (slice 15A). `detectFacts` is pure — globals off the given `win`, markers off
// the given `doc` — so it runs identically in the MAIN world (where page globals ARE visible, via
// `src/entrypoints/injected.content.ts`) and as a DOM-only fallback in the content world, and every
// branch is jsdom-testable with no chrome.*. `createPageFacts` is the content-side orchestrator: ask
// the guarded MAIN-world bridge (`src/dom/bridge.ts`) for the rich result, cache it per URL, and fall
// back to a local DOM-only detection when the MAIN world is unreachable. Read-only + non-secret
// throughout — the MAIN world is the page's own (untrusted) world (CLAUDE.md "MV3 three worlds").

type FactCategory = 'framework' | 'chart' | 'library';

interface Signal {
  /** Canonical, lowercase lib id surfaced in `PageFacts` (e.g. `react`, `chartjs`). */
  readonly id: string;
  readonly category: FactCategory;
  /** Page-window globals whose presence flags this lib (dotted paths allowed, e.g.
   *  `google.visualization`). Visible only in the MAIN world. */
  readonly globals?: readonly string[];
  /** DOM selectors whose presence flags this lib. Visible from BOTH worlds (shared DOM). */
  readonly selectors?: readonly string[];
  /** A framework that implies a client-rendered SPA when present (drives `PageFacts.spa`). */
  readonly spa?: boolean;
}

// Ordered most-specific-first so meta-frameworks (Next, Nuxt, Remix, …) rank ahead of the base
// framework they wrap. Signals are deliberately conservative: a global OR a DOM marker is enough, so
// detection survives whichever the page exposes (globals only in MAIN; markers in both worlds).
const SIGNALS: readonly Signal[] = [
  // meta-frameworks (imply their base framework + an SPA shell)
  {
    id: 'next',
    category: 'framework',
    spa: true,
    globals: ['__NEXT_DATA__', 'next.router', 'next.version'],
    selectors: ['#__next'],
  },
  {
    id: 'nuxt',
    category: 'framework',
    spa: true,
    globals: ['__NUXT__', '$nuxt'],
    selectors: ['#__nuxt'],
  },
  {
    id: 'remix',
    category: 'framework',
    spa: true,
    globals: ['__remixContext', '__remixManifest', '__remixRouteModules'],
  },
  {
    id: 'gatsby',
    category: 'framework',
    spa: true,
    globals: ['___gatsby'],
    selectors: ['#___gatsby'],
  },
  {
    id: 'sveltekit',
    category: 'framework',
    spa: true,
    globals: ['__sveltekit'],
    selectors: ['[data-sveltekit-preload-data]', '[data-sveltekit-preload-code]'],
  },
  // base frameworks
  {
    id: 'react',
    category: 'framework',
    spa: true,
    globals: ['React.version', 'React', '__REACT_DEVTOOLS_GLOBAL_HOOK__'],
    selectors: ['[data-reactroot]', '[data-reactid]'],
  },
  { id: 'preact', category: 'framework', spa: true, globals: ['preact', '__PREACT_DEVTOOLS__'] },
  {
    id: 'vue',
    category: 'framework',
    spa: true,
    globals: ['Vue.version', 'Vue', '__VUE__', '__VUE_DEVTOOLS_GLOBAL_HOOK__'],
    selectors: ['[data-v-app]'],
  },
  {
    id: 'svelte',
    category: 'framework',
    spa: true,
    globals: ['__svelte'],
    selectors: ['[class*="svelte-"]'],
  },
  {
    id: 'angular',
    category: 'framework',
    spa: true,
    globals: ['ng.version', 'getAllAngularRootElements', 'getAllAngularTestabilities'],
    selectors: ['[ng-version]'],
  },
  {
    id: 'angularjs',
    category: 'framework',
    spa: true,
    globals: ['angular.version', 'angular'],
    selectors: ['[ng-app]', '[ng-controller]', '.ng-scope'],
  },
  { id: 'solid', category: 'framework', spa: true, globals: ['_$HY', '__SOLID_DEVTOOLS__'] },
  {
    id: 'ember',
    category: 'framework',
    spa: true,
    globals: ['Ember'],
    selectors: ['.ember-application'],
  },
  { id: 'alpine', category: 'framework', globals: ['Alpine'], selectors: ['[x-data]'] },
  // chart / dataviz libs
  { id: 'chartjs', category: 'chart', globals: ['Chart.instances', 'Chart.version', 'Chart'] },
  { id: 'echarts', category: 'chart', globals: ['echarts.version', 'echarts'] },
  { id: 'highcharts', category: 'chart', globals: ['Highcharts.charts', 'Highcharts'] },
  { id: 'plotly', category: 'chart', globals: ['Plotly'], selectors: ['.js-plotly-plot'] },
  {
    id: 'apexcharts',
    category: 'chart',
    globals: ['ApexCharts'],
    selectors: ['.apexcharts-canvas'],
  },
  { id: 'amcharts', category: 'chart', globals: ['am5', 'am4core'] },
  { id: 'googlecharts', category: 'chart', globals: ['google.visualization'] },
  { id: 'd3', category: 'chart', globals: ['d3.version', 'd3'] },
  { id: 'recharts', category: 'chart', selectors: ['.recharts-wrapper', '.recharts-surface'] },
  // notable libraries
  { id: 'jquery', category: 'library', globals: ['jQuery.fn.jquery', 'jQuery'] },
  { id: 'gsap', category: 'library', globals: ['gsap', 'TweenMax', 'TweenLite'] },
  { id: 'three', category: 'library', globals: ['THREE'] },
  { id: 'bootstrap', category: 'library', globals: ['bootstrap.Modal', 'bootstrap.Tooltip'] },
  { id: 'lodash', category: 'library', globals: ['_.VERSION'] },
  { id: 'moment', category: 'library', globals: ['moment.version'] },
  { id: 'modernizr', category: 'library', globals: ['Modernizr'] },
];

const MAX_FRAMEWORKS = 12;
const MAX_CHART_LIBS = 12;
const MAX_LIBRARIES = 24;

// Read a possibly-dotted global path off the page window WITHOUT tripping a hostile getter: any throw
// (or a non-traversable hop) is treated as "absent". The window is viewed as an untyped record — page
// globals aren't in `Window`'s type, and the MAIN world's real values are page-defined.
function readPath(win: Window, path: string): unknown {
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

function hasGlobal(win: Window, path: string): boolean {
  return readPath(win, path) != null;
}

function hasSelector(doc: Document, selector: string): boolean {
  try {
    return doc.querySelector(selector) !== null;
  } catch {
    return false; // a selector an engine rejects never breaks detection
  }
}

function matches(signal: Signal, win: Window, doc: Document): boolean {
  if (signal.globals?.some((path) => hasGlobal(win, path))) return true;
  if (signal.selectors?.some((selector) => hasSelector(doc, selector))) return true;
  return false;
}

function currentUrl(win: Window): string {
  try {
    return win.location.href;
  } catch {
    return '';
  }
}

/**
 * Detect the runtime stack from page-window globals + shared DOM markers. Deterministic + bounded;
 * every list is length-capped so a hostile page can't inflate the agent's context. `spa` is true when
 * any matched framework is client-rendering (drives the hydration-await doctrine, slice 15A).
 */
export function detectFacts(win: Window, doc: Document): PageFacts {
  const frameworks: string[] = [];
  const chartLibs: string[] = [];
  const libraries: string[] = [];
  let spa = false;

  for (const signal of SIGNALS) {
    if (!matches(signal, win, doc)) continue;
    if (signal.category === 'framework') {
      frameworks.push(signal.id);
      if (signal.spa) spa = true;
    } else if (signal.category === 'chart') {
      chartLibs.push(signal.id);
    } else {
      libraries.push(signal.id);
    }
  }

  return {
    frameworks: frameworks.slice(0, MAX_FRAMEWORKS),
    chartLibs: chartLibs.slice(0, MAX_CHART_LIBS),
    libraries: libraries.slice(0, MAX_LIBRARIES),
    spa,
    url: currentUrl(win),
  };
}

// --- content-side orchestration -------------------------------------------

export interface PageFactsProvider {
  /** Facts for the current document URL — cached after the first resolve; from the guarded
   *  MAIN-world bridge when reachable, else a DOM-only local fallback. */
  get(): Promise<PageFacts>;
  /** Drop cached facts (default: every URL), e.g. after a SPA client-side route change. */
  invalidate(url?: string): void;
}

export interface PageFactsDeps {
  /** The MAIN-world bridge client (`src/dom/bridge.ts`). */
  readonly bridge: Bridge;
  /** Content-world window/document — default to the ambient globals; injectable for tests. */
  readonly win?: Window;
  readonly doc?: Document;
}

export function createPageFacts(deps: PageFactsDeps): PageFactsProvider {
  const win = deps.win ?? window;
  const doc = deps.doc ?? document;
  const cache = new Map<string, PageFacts>();
  const inflight = new Map<string, Promise<PageFacts>>();

  const resolve = async (): Promise<PageFacts> => {
    try {
      const raw = await deps.bridge.request('page-facts');
      const parsed = PageFacts.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      // MAIN world unreachable (strict page / injection blocked) or a malformed reply — fall through.
    }
    // DOM-only best effort: page JS globals aren't visible here, but framework DOM markers + chart
    // wrapper elements still are, so the agent gets a useful (if leaner) picture.
    return detectFacts(win, doc);
  };

  const get = (): Promise<PageFacts> => {
    const url = currentUrl(win);
    const cached = cache.get(url);
    if (cached) return Promise.resolve(cached);
    const shared = inflight.get(url);
    if (shared) return shared;
    // Dedupe concurrent callers onto one MAIN-world probe; cache the result, drop the in-flight entry.
    const pending = resolve().then((facts) => {
      cache.set(url, facts);
      inflight.delete(url);
      return facts;
    });
    inflight.set(url, pending);
    return pending;
  };

  const invalidate = (url?: string): void => {
    if (url === undefined) cache.clear();
    else cache.delete(url);
  };

  return { get, invalidate };
}
