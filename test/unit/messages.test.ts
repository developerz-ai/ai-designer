import { describe, expect, it } from 'vitest';
import { DomTool, PanelToSw } from '@/shared/messages';

describe('message schemas', () => {
  it('accepts a valid user message', () => {
    const r = PanelToSw.safeParse({ type: 'user-message', text: 'make the CTA orange' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown panel message type', () => {
    const r = PanelToSw.safeParse({ type: 'nope', text: 'x' });
    expect(r.success).toBe(false);
  });

  it('parses a setStyle DOM tool', () => {
    const r = DomTool.safeParse({
      type: 'setStyle',
      selector: '[data-testid=cta]',
      props: { 'background-color': '#f97316' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects setStyle without props', () => {
    const r = DomTool.safeParse({ type: 'setStyle', selector: '#x' });
    expect(r.success).toBe(false);
  });
});
