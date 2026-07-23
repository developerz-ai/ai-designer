import { describe, expect, it } from 'vitest';
import { resolveSelector } from '@/dom/selector';
import { addEdit, Changeset, type Edit, emptyChangeset } from '@/shared/changeset';

// The #19 handoff idempotency key — the caller (the SW session) owns it, so
// emptyChangeset takes it explicitly rather than minting a non-deterministic uuid.
const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

// Integration: build a changeset the way the recorder will — resolve the top
// selector candidate from a DOM element, fold an edit in, and validate it parses.
describe('changeset build', () => {
  it('records an edit with a resolved selector and validates', () => {
    document.body.innerHTML = '<button data-testid="cta-primary">Buy</button>';
    const node = document.querySelector('button');
    expect(node).not.toBeNull();

    // resolveSelector returns ranked candidates; the recorder takes the most stable.
    const [selector] = resolveSelector(node as unknown as Parameters<typeof resolveSelector>[0]);
    if (!selector) throw new Error('resolveSelector returned no candidates');
    expect(selector.value).toBe('[data-testid="cta-primary"]');

    const edit: Edit = {
      intent: 'Make the primary CTA orange',
      selector,
      changes: [{ prop: 'background-color', before: '#2563eb', after: '#f97316' }],
      attrs: [],
      classes: [],
      frameworkHints: ['tailwind: bg-blue-600'],
    };

    let cs = emptyChangeset('http://localhost:3000/pricing', '2026-06-21T12:00:00Z', SESSION_ID);
    cs = addEdit(cs, edit);

    const parsed = Changeset.safeParse(cs);
    expect(parsed.success).toBe(true);
    expect(cs.sessionId).toBe(SESSION_ID);
    expect(cs.edits).toHaveLength(1);
    expect(cs.edits[0]?.changes[0]?.after).toBe('#f97316');
  });

  it('requires sessionId (the handoff idempotency key) on a changeset', () => {
    const withoutSession = {
      url: 'http://localhost:3000/pricing',
      createdAt: '2026-06-21T12:00:00Z',
      edits: [],
    };
    expect(Changeset.safeParse(withoutSession).success).toBe(false);
  });

  it('rejects a sessionId that is not a uuid', () => {
    const cs = {
      ...emptyChangeset('http://localhost:3000/pricing', '2026-06-21T12:00:00Z', SESSION_ID),
      sessionId: 'not-a-uuid',
    };
    expect(Changeset.safeParse(cs).success).toBe(false);
  });
});
