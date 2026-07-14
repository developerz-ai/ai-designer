import { afterEach, describe, expect, it } from 'vitest';
import { detectFacts } from '@/dom/page-facts';

// page-facts unit: detect the runtime stack from page-window globals (MAIN-world signals) + shared
// DOM markers (content-visible), producing a bounded, URL-stamped PageFacts. Pure — no chrome.*; we
// stub globals on jsdom's window and markers in its document, mirroring what the MAIN-world bridge
// sees on a real page (src/entrypoints/injected.content.ts).

const globals = (): Record<string, unknown> => window as unknown as Record<string, unknown>;

const added: string[] = [];
function setGlobal(key: string, value: unknown): void {
  globals()[key] = value;
  added.push(key);
}

function mount(html: string): void {
  document.documentElement.removeAttribute('ng-version');
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

afterEach(() => {
  for (const key of added) delete globals()[key];
  added.length = 0;
  mount('');
});

describe('detectFacts — frameworks', () => {
  it('detects React from a page global and flags an SPA', () => {
    setGlobal('React', { version: '18.2.0' });
    const facts = detectFacts(window, document);
    expect(facts.frameworks).toContain('react');
    expect(facts.spa).toBe(true);
  });

  it('detects React from a DOM marker with no global (content-world fallback)', () => {
    mount('<div data-reactroot=""><span>hi</span></div>');
    expect(detectFacts(window, document).frameworks).toContain('react');
  });

  it('detects Next.js + React and lists the meta-framework first', () => {
    setGlobal('React', {});
    setGlobal('__NEXT_DATA__', { props: {} });
    const { frameworks } = detectFacts(window, document);
    expect(frameworks).toContain('next');
    expect(frameworks).toContain('react');
    expect(frameworks.indexOf('next')).toBeLessThan(frameworks.indexOf('react'));
  });

  it('detects Angular from the ng-version attribute', () => {
    document.documentElement.setAttribute('ng-version', '17.0.0');
    expect(detectFacts(window, document).frameworks).toContain('angular');
  });

  it('does not flag an SPA for a plain server-rendered page', () => {
    mount('<main><h1>Static</h1><p>Just HTML.</p></main>');
    const facts = detectFacts(window, document);
    expect(facts.frameworks).toHaveLength(0);
    expect(facts.chartLibs).toHaveLength(0);
    expect(facts.spa).toBe(false);
  });
});

describe('detectFacts — chart + dataviz libs', () => {
  it('detects Chart.js from the global constructor', () => {
    setGlobal(
      'Chart',
      Object.assign(() => {}, { version: '4.4.0', instances: {} }),
    );
    expect(detectFacts(window, document).chartLibs).toContain('chartjs');
  });

  it('detects ECharts + Highcharts from globals', () => {
    setGlobal('echarts', { version: '5.5.0' });
    setGlobal('Highcharts', { charts: [] });
    expect(detectFacts(window, document).chartLibs).toEqual(
      expect.arrayContaining(['echarts', 'highcharts']),
    );
  });

  it('detects Recharts from its SVG surface class (no global)', () => {
    mount('<div class="recharts-wrapper"><svg class="recharts-surface"></svg></div>');
    expect(detectFacts(window, document).chartLibs).toContain('recharts');
  });

  it('detects Google Charts from a nested global path', () => {
    setGlobal('google', { visualization: { DataTable: () => {} } });
    expect(detectFacts(window, document).chartLibs).toContain('googlecharts');
  });
});

describe('detectFacts — libraries + hardening', () => {
  it('detects jQuery from a global', () => {
    setGlobal('jQuery', { fn: { jquery: '3.7.0' } });
    expect(detectFacts(window, document).libraries).toContain('jquery');
  });

  it('treats a throwing global getter as absent (hostile page)', () => {
    Object.defineProperty(window, 'Vue', {
      configurable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(detectFacts(window, document).frameworks).not.toContain('vue');
    delete globals().Vue;
  });

  it('stamps the current document URL', () => {
    expect(detectFacts(window, document).url).toBe(window.location.href);
  });
});
