import { describe, expect, it } from 'vitest';
import {
  type ResponsiveBreakpointFindings,
  renderIdentityTokens,
  renderResponsiveFindings,
  renderResponsiveShots,
  toMarkdown,
} from '@/changeset/report-md';
import type { CheckResponsiveResult, IdentityResult, ResponsiveShot } from '@/shared/messages';
import type { Report } from '@/shared/report';

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

// toMarkdown: the full Report → paste-ready brief (slice 07 / PR12). Golden-file: a complete sample
// report renders to an exact, deterministic Markdown document; the omission cases prove a sparse
// report never emits a bare heading.

const FULL_REPORT: Report = {
  summary: 'Refreshed the pricing hero: warmer accent, tighter vertical rhythm.',
  findings: ['CTA restyled to the brand accent', 'Hero heading bumped to 32px'],
  problems: ['Nav overflows the viewport at 375px'],
  pros: ['Consistent 8px spacing scale'],
  cons: ['Accent contrast is borderline on white'],
  recommendations: ['Add a hover state to the CTA'],
  identity: {
    colors: ['#ffffff (background)', '#111827 (foreground)', '#f97316 (accent)'],
    fonts: ['Inter', 'sans-serif'],
    spacing: ['8px', '16px', '24px'],
  },
  links: [
    { label: 'Edited page', url: 'https://shop.example.com/pricing' },
    { label: 'Reference', url: 'https://stripe.com/pricing' },
  ],
  images: [
    { label: 'Hero — before', src: 'data:image/png;base64,BEFORE' },
    { label: 'Hero — after', src: 'data:image/png;base64,AFTER', caption: 'Accent applied' },
  ],
};

const GOLDEN = `
# Design review

Refreshed the pricing hero: warmer accent, tighter vertical rhythm.

## Design tokens

| Token | Values |
| --- | --- |
| Colors | \`#ffffff (background)\`, \`#111827 (foreground)\`, \`#f97316 (accent)\` |
| Fonts | \`Inter\`, \`sans-serif\` |
| Spacing | \`8px\`, \`16px\`, \`24px\` |

## Findings

- CTA restyled to the brand accent
- Hero heading bumped to 32px

## Problems

- Nav overflows the viewport at 375px

## Pros

- Consistent 8px spacing scale

## Cons

- Accent contrast is borderline on white

## Recommendations

- Add a hover state to the CTA

## References

- [Edited page](https://shop.example.com/pricing)
- [Reference](https://stripe.com/pricing)

## Screenshots

**Hero — before**

![Hero — before](data:image/png;base64,BEFORE)

**Hero — after**

_Accent applied_

![Hero — after](data:image/png;base64,AFTER)
`.trim();

const EMPTY_REPORT: Report = {
  summary: '',
  findings: [],
  problems: [],
  pros: [],
  cons: [],
  recommendations: [],
  identity: { colors: [], fonts: [], spacing: [] },
  links: [],
  images: [],
};

describe('toMarkdown', () => {
  it('renders a full report to the exact golden Markdown brief', () => {
    expect(toMarkdown(FULL_REPORT)).toBe(GOLDEN);
  });

  it('degrades to just the title when the report is empty (no bare headings)', () => {
    const md = toMarkdown(EMPTY_REPORT);
    expect(md).toBe('# Design review');
    expect(md).not.toContain('##');
  });

  it('omits a section whose list is empty rather than emitting a bare heading', () => {
    const md = toMarkdown({ ...EMPTY_REPORT, summary: 'x', problems: ['Overflow at 375px'] });
    expect(md).toContain('## Problems');
    expect(md).not.toContain('## Findings');
    expect(md).not.toContain('## Design tokens');
    expect(md).not.toContain('## Screenshots');
  });

  it('embeds each screenshot under its label, with the caption only when present', () => {
    const md = toMarkdown({
      ...EMPTY_REPORT,
      images: [
        { label: 'After', src: 'data:image/png;base64,ZZ', caption: 'note' },
        { label: 'Plain', src: 'https://cdn/x.png' },
      ],
    });
    expect(md).toContain('**After**\n\n_note_\n\n![After](data:image/png;base64,ZZ)');
    expect(md).toContain('**Plain**\n\n![Plain](https://cdn/x.png)');
  });

  it('renders only the token rows that have values', () => {
    const md = toMarkdown({
      ...EMPTY_REPORT,
      identity: { colors: [], fonts: ['Inter'], spacing: [] },
    });
    expect(md).toContain('## Design tokens');
    expect(md).toContain('| Fonts | `Inter` |');
    expect(md).not.toContain('| Colors |');
    expect(md).not.toContain('| Spacing |');
  });
});
