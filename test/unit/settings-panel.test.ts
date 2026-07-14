import { describe, expect, it } from 'vitest';
import { clearKeyOnSave } from '@/entrypoints/sidepanel/components/SettingsPanel';

// The Save click wipes the key input only on a validated save. A host-permission denial or a
// rejected config leaves `saveStatus` at `invalid`/`saving`, so the typed key must survive for a
// retry rather than forcing a re-type.
describe('clearKeyOnSave', () => {
  it('clears the key input after a validated save', () => {
    expect(clearKeyOnSave('valid')).toBe(true);
  });

  it.each(['invalid', 'saving', 'idle'] as const)('keeps the key input on "%s"', (status) => {
    expect(clearKeyOnSave(status)).toBe(false);
  });
});
