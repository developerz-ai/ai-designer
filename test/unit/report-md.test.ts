import { describe, expect, it } from 'vitest';
import {
  type ResponsiveBreakpointFindings,
  renderIdentityTokens,
  renderResponsiveFindings,
  renderResponsiveShots,
} from '@/changeset/report-md';
import type { CheckResponsiveResult, IdentityResult, ResponsiveShot } from '@/shared/messages';

// report-md.ts unit (slice 14/16 hooks for PR12's report): `renderIdentityTokens` turns an
// extracted `IdentityResult` into a Markdown tokens table + typography/spacing sections;
// `renderResponsiveFindings`/`renderResponsiveShots` turn per-breakpoint `checkResponsive`/
// `responsiveCapture` results into a Markdown findings table + embedded captures — deterministic,
// no chrome.*, so a regression here shows up before the full report assembly (PR12) ever runs.

const IDENTITY: IdentityResult = {
  palette: [
    { hex: '#ffffff', role: 'bg', count: 5 },
    { hex: '#111827', role: 'fg', count: 4 },
    { hex: '#f97316', role: 'accent', count: 2 },
    { hex: '#e5e7eb', role: 'border', count: 3 },
  ],
  type: { families: ['Inter', 'sans-serif'], sizes: [32, 20, 16, 14], weights: [400, 600, 700] },
  spacing: [8, 16, 24],
  radius: [8],
  shadows: ['0 1px 2px rgba(0,0,0,0.2)'],
};

const EMPTY_IDENTITY: IdentityResult = {
  palette: [],
  type: { families: [], sizes: [], weights: [] },
  spacing: [],
  radius: [],
  shadows: [],
};

describe('renderIdentityTokens', () => {
  it('renders a color tokens table with role, hex, and sample count', () => {
    const md = renderIdentityTokens(IDENTITY);
    expect(md).toContain('### Color tokens');
    expect(md).toContain('| Background | `#ffffff` | 5 |');
    expect(md).toContain('| Accent | `#f97316` | 2 |');
    expect(md).toContain('| Border | `#e5e7eb` | 3 |');
  });

  it('renders typography as families / scale / weights', () => {
    const md = renderIdentityTokens(IDENTITY);
    expect(md).toContain('### Typography');
    expect(md).toContain('**Families:** Inter, sans-serif');
    expect(md).toContain('**Scale:** 32px, 20px, 16px, 14px');
    expect(md).toContain('**Weights:** 400, 600, 700');
  });

  it('renders spacing, radius, and shadows', () => {
    const md = renderIdentityTokens(IDENTITY);
    expect(md).toContain('### Spacing & effects');
    expect(md).toContain('**Spacing:** 8px, 16px, 24px');
    expect(md).toContain('**Radius:** 8px');
    expect(md).toContain('**Shadows:** 0 1px 2px rgba(0,0,0,0.2)');
  });

  it('speaks in tokens, never raw/undecorated hex outside the table', () => {
    const md = renderIdentityTokens(IDENTITY);
    const outsideTable = md.replace(/\| .* \| `#[0-9a-f]+` \| \d+ \|/gi, '');
    expect(outsideTable).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('returns an empty string for an identity with nothing extracted', () => {
    expect(renderIdentityTokens(EMPTY_IDENTITY)).toBe('');
  });

  it('omits a section entirely when its fields are empty, rather than an empty heading', () => {
    const partial: IdentityResult = { ...EMPTY_IDENTITY, palette: IDENTITY.palette };
    const md = renderIdentityTokens(partial);
    expect(md).toContain('### Color tokens');
    expect(md).not.toContain('### Typography');
    expect(md).not.toContain('### Spacing & effects');
  });
});

const finding = (
  overrides: Partial<CheckResponsiveResult['findings'][number]> = {},
): CheckResponsiveResult['findings'][number] => ({
  category: 'overflow',
  severity: 'moderate',
  detail: 'element overflows the viewport',
  selector: { value: '.hero', strategy: 'css-path', fragile: false },
  ...overrides,
});

const MOBILE_FINDINGS: ResponsiveBreakpointFindings = {
  label: 'iPhone SE',
  result: {
    viewportWidth: 375,
    findings: [
      finding({ category: 'tap-target', severity: 'minor', detail: 'button is 32x32px' }),
      finding({ category: 'overflow', severity: 'serious', detail: 'nav overflows by 40px' }),
    ],
  },
};

const DESKTOP_CLEAN: ResponsiveBreakpointFindings = {
  label: 'Desktop',
  result: { viewportWidth: 1440, findings: [] },
};

describe('renderResponsiveFindings', () => {
  it('renders one heading + table per breakpoint that has findings', () => {
    const md = renderResponsiveFindings([MOBILE_FINDINGS]);
    expect(md).toContain('### iPhone SE (375px)');
    expect(md).toContain('| Severity | Category | Detail | Selector |');
    expect(md).toContain('`.hero`');
  });

  it('sorts findings most-severe-first within a breakpoint', () => {
    const md = renderResponsiveFindings([MOBILE_FINDINGS]);
    const seriousIdx = md.indexOf('Serious');
    const minorIdx = md.indexOf('Minor');
    expect(seriousIdx).toBeGreaterThanOrEqual(0);
    expect(seriousIdx).toBeLessThan(minorIdx);
  });

  it('skips a breakpoint with no findings', () => {
    const md = renderResponsiveFindings([MOBILE_FINDINGS, DESKTOP_CLEAN]);
    expect(md).not.toContain('### Desktop');
  });

  it('returns an empty string when every breakpoint is clean', () => {
    expect(renderResponsiveFindings([DESKTOP_CLEAN])).toBe('');
    expect(renderResponsiveFindings([])).toBe('');
  });
});

const shot = (overrides: Partial<ResponsiveShot> = {}): ResponsiveShot => ({
  label: 'Mobile',
  metrics: { width: 375, height: 667, dpr: 2, touch: true, mobile: true },
  mechanism: 'cdp',
  image: 'AAAA',
  ...overrides,
});

describe('renderResponsiveShots', () => {
  it('embeds a data-URI image per breakpoint with its label and dimensions', () => {
    const md = renderResponsiveShots([shot()]);
    expect(md).toContain('### Responsive captures');
    expect(md).toContain('**Mobile** (375×667)');
    expect(md).toContain('![Mobile](data:image/png;base64,AAAA)');
  });

  it('renders a failure note instead of a broken image link for a failed capture', () => {
    const md = renderResponsiveShots([shot({ image: undefined, error: 'tab closed' })]);
    expect(md).toContain('capture failed: tab closed');
    expect(md).not.toContain('![Mobile]');
  });

  it('returns an empty string for an empty shot set', () => {
    expect(renderResponsiveShots([])).toBe('');
  });
});
