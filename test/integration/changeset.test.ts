import { describe, expect, it } from 'vitest';
import { resolveSelector } from '@/dom/selector';
import { addEdit, Changeset, type Edit, emptyChangeset } from '@/shared/changeset';

// Integration: build a changeset the way the recorder will — resolve a selector
// from a DOM element, fold an edit in, and validate the whole thing parses.
describe('changeset build', () => {
  it('records an edit with a resolved selector and validates', () => {
    document.body.innerHTML = '<button data-testid="cta-primary">Buy</button>';
    const node = document.querySelector('button');
    expect(node).not.toBeNull();

    const selector = resolveSelector(node as unknown as Parameters<typeof resolveSelector>[0]);
    expect(selector.value).toBe('[data-testid="cta-primary"]');

    const edit: Edit = {
      intent: 'Make the primary CTA orange',
      selector,
      changes: [{ prop: 'background-color', before: '#2563eb', after: '#f97316' }],
      frameworkHints: ['tailwind: bg-blue-600'],
    };

    let cs = emptyChangeset('http://localhost:3000/pricing', '2026-06-21T12:00:00Z');
    cs = addEdit(cs, edit);

    const parsed = Changeset.safeParse(cs);
    expect(parsed.success).toBe(true);
    expect(cs.edits).toHaveLength(1);
    expect(cs.edits[0]?.changes[0]?.after).toBe('#f97316');
  });
});
