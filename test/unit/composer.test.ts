import { describe, expect, it } from 'vitest';
import { isSubmitKey } from '@/entrypoints/sidepanel/components/chat/Composer';

// Pure keydown decision behind Composer's Enter-send/Shift+Enter-newline contract — no DOM/Solid
// mount needed (mirrors icon-registry.test.ts's buildIconClass coverage style). The mounted
// behaviour (accessible names, the send/stop slot) is covered in composer-view.test.tsx.
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

  // The predicate used to check `shiftKey` only, despite claiming to cover "any other modifier
  // combo" — Ctrl/Cmd/Alt+Enter all sent.
  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
    ['Alt+Enter', { altKey: true }],
  ])('%s does not submit', (_name, mods) => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, ...mods })).toBe(false);
  });

  // The real bug this guard exists for: committing a Japanese/Chinese/Korean IME candidate fires
  // a keydown for Enter with `isComposing: true`. Without the guard that first Enter sends a
  // half-composed message.
  it('the Enter that commits an IME candidate does not submit', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });

  it('submits once composition has ended', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
  });

  // A held Enter autorepeats; without this each repeat would fire another send.
  it('an autorepeated Enter does not submit again', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, repeat: true })).toBe(false);
  });

  it('accepts a real KeyboardEvent (all fields present)', () => {
    const e = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(isSubmitKey(e)).toBe(true);
  });
});
