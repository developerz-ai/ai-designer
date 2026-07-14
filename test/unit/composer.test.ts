import { describe, expect, it } from 'vitest';
import { isSubmitKey } from '@/entrypoints/sidepanel/components/chat/Composer';

// Pure keydown decision behind Composer's Enter-send/Shift+Enter-newline contract — no DOM/Solid
// mount needed (mirrors icon-registry.test.ts's buildIconClass coverage style).
describe('isSubmitKey', () => {
  it('Enter without a modifier submits', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('Shift+Enter inserts a newline instead of submitting', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('any other key is not a submit', () => {
    expect(isSubmitKey({ key: 'a', shiftKey: false })).toBe(false);
  });
});
