import { describe, expect, it } from 'vitest';
import { renderChangeset, renderStylesheet } from '@/changeset/changeset-md';
import { toMarkdown } from '@/changeset/report-md';
import type { Changeset, Edit } from '@/shared/changeset';
import type { Report } from '@/shared/report';

// The export is the product. When no coding backend is connected, Ship hands the user one Markdown
// file and nothing else; a coding agent reads it in a repo it has never seen. These assert that the
// file is actually actionable — the defect the HN session exposed was not that the record was
// wrong, it was that the record was true and useless.

function edit(over: Partial<Edit> = {}): Edit {
  return {
    intent: 'Cap the main column at a readable measure',
    selector: { value: 'table.itemlist', strategy: 'css-path', fragile: false },
    changes: [{ prop: 'max-width', before: '1605.64px', after: '960px' }],
    attrs: [],
    classes: [],
    frameworkHints: [],
    ...over,
  };
}

function changeset(edits: Edit[], stylesheets: Changeset['stylesheets'] = []): Changeset {
  return {
    url: 'https://news.ycombinator.com/',
    createdAt: '2026-08-14T00:00:00.000Z',
    sessionId: '11111111-2222-4333-8444-555555555555',
    edits,
    stylesheets,
  };
}

const REPORT: Report = {
  summary: 'Modernized the front page.',
  findings: [],
  problems: [],
  pros: [],
  cons: [],
  recommendations: [],
  identity: { colors: [], fonts: [], spacing: [] },
  links: [],
  images: [],
};

describe('renderStylesheet', () => {
  it('emits the style deltas as liftable CSS with the intent as the comment', () => {
    const md = renderStylesheet(changeset([edit()]));
    expect(md).toContain('table.itemlist {');
    expect(md).toContain('max-width: 960px;');
    expect(md).toContain('Cap the main column at a readable measure');
  });

  it('warns inside the stylesheet when the rule is hung off an untrustworthy selector', () => {
    const md = renderStylesheet(
      changeset([
        edit({
          selector: {
            value: '#hnmain > tbody:nth-of-type(1) > tr:nth-of-type(3)',
            strategy: 'css-path',
            fragile: true,
          },
        }),
      ]),
    );
    // The rule is still emitted — it is the best description of the change we have — but a reader
    // is told not to paste the selector verbatim.
    expect(md).toContain('positional path');
  });

  it('cannot be broken out of by an intent string carrying a comment terminator', () => {
    const md = renderStylesheet(changeset([edit({ intent: 'oops */ body { display: none } /*' })]));
    // The terminator is escaped, so the injected text stays INSIDE the comment. CSS comments do
    // not nest and do not honour backslash escapes, so `*\\/` is simply not a terminator.
    expect(md).toContain('*\\/ body');
    // …and the rule that follows is still ours.
    expect(md).toContain('table.itemlist {');
  });

  it('renders nothing at all for a session with no style changes', () => {
    expect(renderStylesheet(changeset([edit({ changes: [] })]))).toBe('');
    expect(renderStylesheet(changeset([]))).toBe('');
  });
});

describe('renderChangeset', () => {
  it('leads with how much of the record can be mapped back to source', () => {
    const md = renderChangeset(
      changeset([
        edit(),
        edit({ selector: { value: '#\\34 9299222', strategy: 'id', fragile: true } }),
      ]),
    );
    expect(md).toContain('2 edits, 1 of them against a selector that will not survive');
  });

  it('tells a coding agent what a record-key id actually is', () => {
    const md = renderChangeset(
      changeset([edit({ selector: { value: '#\\34 9299222', strategy: 'id', fragile: true } })]),
    );
    expect(md).toContain('record-key id');
    expect(md).toContain('Find the template that renders this row');
  });

  it('describes a structural edit as structure, not as a node operation', () => {
    const md = renderChangeset(
      changeset([
        edit({
          intent: 'Wrap the story list in a semantic container',
          changes: [],
          structural: {
            op: 'insert',
            html: '<section class="stories"></section>',
            position: 'beforebegin',
            refSelector: { value: 'table.itemlist', strategy: 'css-path', fragile: false },
          },
        }),
      ]),
    );
    expect(md).toContain('**Structure:** new markup added beforebegin');
    expect(md).toContain('<section class="stories"></section>');
  });

  it('reports an attribute REMOVAL distinctly from an attribute set', () => {
    const md = renderChangeset(
      changeset([
        edit({
          changes: [],
          attrs: [{ name: 'width', before: '85%', after: null }],
        }),
      ]),
    );
    expect(md).toContain('**Attribute removed:** `width` (was `85%`)');
  });
});

describe('toMarkdown', () => {
  it('carried NO edits before the changeset was passed in — the export was prose only', () => {
    // The defect: `background.ts` calls `toMarkdown(report)` for the download path, so the file the
    // user hands to their coding agent never contained a single actual change.
    const proseOnly = toMarkdown(REPORT);
    expect(proseOnly).not.toContain('max-width');
    expect(proseOnly).not.toContain('## Edits');
  });

  it('carries the stylesheet and the edit list when the changeset is passed', () => {
    const md = toMarkdown(REPORT, changeset([edit()]));
    expect(md).toContain('## Proposed CSS');
    expect(md).toContain('## Edits');
    expect(md).toContain('max-width: 960px;');
    // Prose still leads — intent frames the mechanics.
    expect(md.indexOf('Modernized the front page.')).toBeLessThan(md.indexOf('## Proposed CSS'));
  });
});

describe('renderStylesheet with an authored sheet', () => {
  it('leads with the injected stylesheet — the thing a developer actually lifts', () => {
    const md = renderStylesheet(
      changeset(
        [edit()],
        [
          {
            id: 'design-system',
            css: ':root { --space-4: 1rem }\nmain { max-width: 72rem; margin-inline: auto }',
            intent: 'A token layer and a readable measure',
          },
        ],
      ),
    );
    expect(md).toContain('### A token layer and a readable measure');
    expect(md).toContain('margin-inline: auto');
    // Per-element deltas are still there, but clearly subordinate to the authored sheet.
    expect(md).toContain('### Per-element adjustments');
    expect(md.indexOf('--space-4')).toBeLessThan(md.indexOf('Per-element adjustments'));
  });

  it('falls back to the sheet id when it carries no intent', () => {
    const md = renderStylesheet(changeset([], [{ id: 'layout', css: 'main { display: grid }' }]));
    expect(md).toContain('### Stylesheet `layout`');
    expect(md).not.toContain('Per-element adjustments');
  });
});

describe('renderChangeset for the restructuring ops', () => {
  it('describes a wrap as the shape the markup should take', () => {
    const md = renderChangeset(
      changeset([
        edit({
          intent: 'Give the story list a landmark',
          changes: [],
          structural: { op: 'wrap', html: '<section class="stories">' },
        }),
      ]),
    );
    expect(md).toContain('wrapped in a new container');
    expect(md).toContain('<section class="stories">');
  });

  it('names the far end of a wrapped RANGE', () => {
    const md = renderChangeset(
      changeset([
        edit({
          changes: [],
          structural: {
            op: 'wrap',
            html: '<section>',
            endSelector: { value: '#last', strategy: 'id', fragile: false },
          },
        }),
      ]),
    );
    expect(md).toContain('through** `#last`');
  });

  it('says an unwrap deletes nesting, not content', () => {
    const md = renderChangeset(
      changeset([
        edit({ changes: [], structural: { op: 'unwrap', html: '<center id="legacy">' } }),
      ]),
    );
    expect(md).toContain('children take its place');
    expect(md).toContain('no content lost');
  });

  it('renders a replace as a delta, showing what was there before', () => {
    const md = renderChangeset(
      changeset([
        edit({
          changes: [],
          structural: {
            op: 'replace',
            html: '<section><ul></ul></section>',
            replacedHtml: '<table id="t"></table>',
          },
        }),
      ]),
    );
    expect(md).toContain('become:');
    expect(md).toContain('Replacing:');
    expect(md).toContain('<table id="t">');
  });
});
