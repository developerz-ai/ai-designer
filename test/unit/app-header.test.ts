import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A GUARD, not a behavioural test — "make the machine careful" (00-philosophy.md §5): a rule in a
// comment is advice the next agent can miss, a failing test is a fact it cannot.
//
// WHAT IT PROTECTS: the panel's header row. Its ONE coloured element is the readiness pill
// (#179) — the brand logo used to sit beside it as a second warm block, so the status pill
// stopped reading as the status. The row now carries the wordmark disclosure and the readiness
// cluster, nothing else, and the 24px the image took went to the wordmark, which is the row's
// only flexible child at the 360px panel width Chrome pins the panel to.
//
// It is a SOURCE guard on purpose: the thing it forbids — an image in the header row — is a
// one-line edit in App.tsx, and App.tsx is where the next agent is looking. The shape follows
// test/unit/shared-import-graph.test.ts: read the source, pull out the part that matters, assert
// a fact about it — then prove the matcher can still fail.

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

/**
 * The header row's own markup. Throws rather than returning '' — a matcher that finds NOTHING
 * must not read as "nothing wrong", or the guard would pass on a renamed header forever.
 */
function headerBlock(source: string): string {
  const block = source.match(/<header class="dz-app__header">[\s\S]*?<\/header>/)?.[0];
  if (!block) throw new Error('no <header class="dz-app__header"> block in the source');
  return block;
}

/** JSX comments are not DOM: a comment that NAMES an image is not an image. */
function markup(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every reason the header row would carry a brand block. Empty = the row is clean. The entries
 * name the reason, so a failure says WHAT came back, not just "not empty".
 */
function headerBrandViolations(block: string): string[] {
  const violations: string[] = [];
  for (const tag of block.match(/<img\b[^>]*>/g) ?? []) {
    violations.push(`an <img> is back in the header: ${tag}`);
  }
  if (block.includes('dz-app__logo')) {
    violations.push('the dz-app__logo class is back in the header');
  }
  return violations;
}

describe('the panel header carries no brand block', () => {
  it('the header row has no image in it', () => {
    const header = markup(headerBlock(read('src/entrypoints/sidepanel/App.tsx')));
    expect(headerBrandViolations(header)).toEqual([]);
  });

  it('the header row still holds the two controls it exists for', () => {
    const header = markup(headerBlock(read('src/entrypoints/sidepanel/App.tsx')));
    expect(header).toContain('<NavMenu');
    expect(header).toContain('<ReadinessDropdown');
  });
});

describe('the guard itself detects what it claims to', () => {
  // A guard that cannot fail is worse than no guard: it reads as protection and provides none.
  const planted = `<header class="dz-app__header">
  <img class="dz-app__logo" src="/logo.png" alt="developerz.ai" />
  <NavMenu />
  <ReadinessDropdown onNavigate={() => {}} />
</header>`;

  it('flags a header that carries a brand image', () => {
    const violations = headerBrandViolations(markup(headerBlock(planted)));
    // Both detectors fire: the element itself and the class it carries.
    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('<img>');
    expect(violations.join('\n')).toContain('dz-app__logo');
  });

  it('passes a header that carries none', () => {
    const clean = `<header class="dz-app__header">
  <NavMenu />
  <ReadinessDropdown onNavigate={() => {}} />
</header>`;
    expect(headerBrandViolations(markup(headerBlock(clean)))).toEqual([]);
  });
});
