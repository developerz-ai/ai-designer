import { describe, expect, it } from 'vitest';
import { classifyTool, overlayLabel } from '@/shared/overlay-step';

describe('classifyTool', () => {
  it('classifies a mutating tool as "act" even without a selector', () => {
    expect(classifyTool('undo', {})).toEqual({ kind: 'act' });
  });

  it('classifies a mutating tool with a selector as "act", carrying the selector', () => {
    expect(classifyTool('setStyle', { selector: '.hero', props: {} })).toEqual({
      selector: '.hero',
      kind: 'act',
    });
  });

  it('classifies the real driving tool names pressKey/selectOption as "act"', () => {
    expect(classifyTool('pressKey', { key: 'Enter' })).toEqual({ kind: 'act' });
    expect(classifyTool('selectOption', { selector: '#country', value: 'US' })).toEqual({
      selector: '#country',
      kind: 'act',
    });
  });

  it('classifies a non-mutating tool with a selector as "read"', () => {
    expect(classifyTool('query', { selector: '.hero' })).toEqual({
      selector: '.hero',
      kind: 'read',
    });
  });

  it('classifies a non-mutating, selector-less tool as "info"', () => {
    expect(classifyTool('navigate', { url: 'https://example.com' })).toEqual({ kind: 'info' });
  });

  it('ignores a non-string selector field rather than throwing', () => {
    expect(classifyTool('query', { selector: 42 })).toEqual({ kind: 'info' });
  });

  it('handles non-object input', () => {
    expect(classifyTool('browse', undefined)).toEqual({ kind: 'info' });
    expect(classifyTool('browse', null)).toEqual({ kind: 'info' });
  });
});

describe('overlayLabel', () => {
  it('composes "tool → selector" when a selector is present', () => {
    expect(overlayLabel('setStyle', '.hero')).toBe('setStyle → .hero');
  });

  it('falls back to the bare tool name with no selector', () => {
    expect(overlayLabel('navigate', undefined)).toBe('navigate');
  });
});
