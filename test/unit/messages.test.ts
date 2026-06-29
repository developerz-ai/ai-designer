import { describe, expect, it } from 'vitest';
import {
  DomTool,
  KeyStatusResult,
  ModelsResult,
  PanelToSw,
  SaveKeyResult,
} from '@/shared/messages';

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

describe('settings message schemas', () => {
  it('accepts save-openrouter-key with a non-empty key', () => {
    expect(PanelToSw.safeParse({ type: 'save-openrouter-key', text: 'sk-or-x' }).success).toBe(
      true,
    );
  });

  it('rejects save-openrouter-key with an empty key', () => {
    expect(PanelToSw.safeParse({ type: 'save-openrouter-key', text: '' }).success).toBe(false);
  });

  it('accepts set-model and key-status / list-models / clear', () => {
    expect(PanelToSw.safeParse({ type: 'set-model', model: 'anthropic/claude' }).success).toBe(
      true,
    );
    expect(PanelToSw.safeParse({ type: 'key-status' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'list-models' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'clear-openrouter-key' }).success).toBe(true);
  });

  it('rejects set-model without a model id', () => {
    expect(PanelToSw.safeParse({ type: 'set-model' }).success).toBe(false);
  });

  it('parses the SW RPC response shapes', () => {
    expect(SaveKeyResult.safeParse({ ok: true, valid: true }).success).toBe(true);
    expect(KeyStatusResult.safeParse({ ok: true, present: false }).success).toBe(true);
    expect(ModelsResult.safeParse({ ok: true, models: [{ id: 'a/b', name: 'B' }] }).success).toBe(
      true,
    );
  });
});
