import type { LanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  buildReportContext,
  buildReportMessages,
  collectImages,
  collectLinks,
  type GenerateReport,
  generateReport,
  identityTokens,
  type ReportInput,
} from '@/agent/report';
import { type Changeset, type Edit, emptyChangeset } from '@/shared/changeset';
import type { DiagnosticsReport } from '@/shared/diagnostics';
import type { IdentityResult } from '@/shared/messages';

// report.ts unit: the summarization pass authors the brief's prose via an injected `generate` (a
// fake, no model), then grounds identity/links/images from the session deterministically. Mirrors
// vision.ts's injection so it's chrome-free and provider-free.

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const URL = 'https://example.com/pricing';

const edit = (intent: string, screenshots?: Edit['screenshots']): Edit => ({
  intent,
  selector: { value: `#${intent}`, strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: '#000', after: '#0af' }],
  frameworkHints: [],
  ...(screenshots ? { screenshots } : {}),
});

const changesetWith = (...edits: Edit[]): Changeset => ({
  ...emptyChangeset(URL, '2026-07-13T00:00:00Z', SESSION_ID),
  edits,
});

const identity: IdentityResult = {
  palette: [
    { hex: '#0a0a0a', role: 'bg', count: 40 },
    { hex: '#00aaff', role: 'accent', count: 6 },
  ],
  type: { families: ['Inter', 'system-ui'], sizes: [32, 16], weights: [700, 400] },
  spacing: [8, 16, 24],
  radius: [4, 8],
  shadows: ['0 1px 2px rgba(0,0,0,.1)'],
};

const diagnostics: DiagnosticsReport = {
  url: URL,
  generatedAt: '2026-07-13T00:00:00Z',
  findings: [
    {
      id: 'layout:hero',
      category: 'layout',
      severity: 'error',
      title: 'Hero image overflows on mobile',
      detail: 'The hero exceeds the viewport at 375px.',
      status: 'confirmed',
      occurrences: 1,
      evidence: [],
      repro: [],
      relatedIds: [],
      proposedFix: 'Set max-width: 100% on .hero img',
    },
  ],
  summary: { total: 1, byCategory: { layout: 1 }, bySeverity: { error: 1 } },
};

const DRAFT = {
  summary: 'Recolored the CTA and tightened the hero.',
  findings: ['CTA contrast improved'],
  problems: ['Hero image overflows on mobile'],
  pros: ['Consistent accent usage'],
  cons: ['Spacing scale is irregular'],
  recommendations: ['Adopt an 8px spacing grid'],
};

const model = {} as unknown as LanguageModel;

function fakeGenerate(object: unknown): {
  generate: GenerateReport;
  calls: Array<Parameters<GenerateReport>[0]>;
} {
  const calls: Array<Parameters<GenerateReport>[0]> = [];
  const generate: GenerateReport = (args) => {
    calls.push(args);
    return Promise.resolve({ object });
  };
  return { generate, calls };
}

describe('generateReport: assembles a grounded, agent-authored brief', () => {
  it('keeps the model prose and grounds identity, links, and images', async () => {
    const input: ReportInput = {
      changeset: changesetWith(edit('cta', { after: 'data:image/png;base64,AAA' })),
      identity,
      diagnostics,
      images: [{ label: 'Full page', src: 'data:image/png;base64,BBB' }],
      mode: 'copy',
    };
    const { generate } = fakeGenerate(DRAFT);

    const report = await generateReport({ model, generate }, input);

    // Prose is the model's.
    expect(report.summary).toBe(DRAFT.summary);
    expect(report.problems).toEqual(DRAFT.problems);
    expect(report.recommendations).toEqual(DRAFT.recommendations);
    // Identity is grounded from the extracted IdentityResult (role-tagged), not invented.
    expect(report.identity.colors).toEqual(['#0a0a0a (background)', '#00aaff (accent)']);
    expect(report.identity.fonts).toEqual(['Inter', 'system-ui']);
    expect(report.identity.spacing).toEqual(['8px', '16px', '24px']);
    // Links lead with the edited page.
    expect(report.links[0]).toEqual({ label: 'Edited page', url: URL });
    // Images: the edit's after-shot plus the extra capture.
    expect(report.images.map((i) => i.src)).toEqual([
      'data:image/png;base64,AAA',
      'data:image/png;base64,BBB',
    ]);
  });

  it('passes the schema, a system prompt, and screenshot image parts to the model', async () => {
    const input: ReportInput = {
      changeset: changesetWith(edit('cta', { after: 'data:image/png;base64,AAA' })),
    };
    const { generate, calls } = fakeGenerate(DRAFT);

    await generateReport({ model, generate }, input);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.schema).toBeDefined();
    expect(calls[0]?.system).toMatch(/senior web developer/i);
    const parts = calls[0]?.messages[0]?.content;
    expect(Array.isArray(parts) && parts.some((p) => p.type === 'image')).toBe(true);
  });

  it('falls back to a deterministic summary when the model reply is malformed', async () => {
    const input: ReportInput = { changeset: changesetWith(edit('a'), edit('b')), diagnostics };
    const { generate } = fakeGenerate({ not: 'a report' });

    const report = await generateReport({ model, generate }, input);

    expect(report.summary).toContain('2 edit(s)');
    expect(report.summary).toContain('1 diagnosed problem(s)');
    expect(report.problems).toEqual([]); // empty prose, still a valid Report
  });

  it('propagates a model/transport error', async () => {
    const generate: GenerateReport = () => Promise.reject(new Error('rate limited'));
    await expect(
      generateReport({ model, generate }, { changeset: changesetWith(edit('a')) }),
    ).rejects.toThrow('rate limited');
  });
});

describe('report grounding helpers (pure)', () => {
  it('identityTokens role-tags colors and formats spacing', () => {
    expect(identityTokens(identity)).toEqual({
      colors: ['#0a0a0a (background)', '#00aaff (accent)'],
      fonts: ['Inter', 'system-ui'],
      spacing: ['8px', '16px', '24px'],
    });
  });

  it('collectLinks puts the page first and dedupes by url', () => {
    const links = collectLinks({
      changeset: changesetWith(edit('a')),
      links: [
        { label: 'Ref', url: 'https://ref.example' },
        { label: 'Dup page', url: URL }, // same as the edited page -> dropped
      ],
    });
    expect(links).toEqual([
      { label: 'Edited page', url: URL },
      { label: 'Ref', url: 'https://ref.example' },
    ]);
  });

  it('collectImages takes before/after per edit then extras, deduped by src', () => {
    const images = collectImages({
      changeset: changesetWith(
        edit('cta', { before: 'data:b', after: 'data:a' }),
        edit('nav', { after: 'data:a' }), // duplicate src -> dropped
      ),
      images: [{ label: 'Extra', src: 'data:x' }],
    });
    expect(images.map((i) => i.src)).toEqual(['data:b', 'data:a', 'data:x']);
    expect(images[0]?.label).toBe('cta — before');
  });

  it('does not feed a remote-URL screenshot to the vision model but still embeds it', () => {
    const input: ReportInput = {
      changeset: changesetWith(edit('cta', { after: 'https://cdn.example/x.png' })),
    };
    expect(collectImages(input)).toHaveLength(1); // embedded in the report
    const parts = buildReportMessages(input)[0]?.content;
    // Only the context text part — the http image is not sent as a vision part.
    expect(Array.isArray(parts) && parts.filter((p) => p.type === 'image')).toHaveLength(0);
  });
});

describe('buildReportContext', () => {
  it('digests edits, diagnostics, and identity tokens', () => {
    const text = buildReportContext({
      changeset: changesetWith(edit('recolor cta')),
      diagnostics,
      identity,
      mode: 'debug',
    });
    expect(text).toContain('Mode: debug');
    expect(text).toContain(URL);
    expect(text).toContain('recolor cta');
    expect(text).toContain('Hero image overflows on mobile');
    expect(text).toContain('Colors: #0a0a0a (background), #00aaff (accent)');
  });
});
