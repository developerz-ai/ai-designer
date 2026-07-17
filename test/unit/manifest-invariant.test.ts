import { describe, expect, it } from 'vitest';
import wxtConfig from '../../wxt.config';

// Guards the least-privilege manifest invariant documented in
// docs/architecture/security.md. Reads the live wxt.config.ts manifest (no
// hardcoded list) so any drift in the granted surface fails this test.

// Cast through unknown to a permissive shape: wxt's UserManifest types are
// deep unions across MV2/MV3, but we only inspect the permission arrays here.
const manifest = (
  wxtConfig as {
    manifest: {
      permissions?: string[];
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };
  }
).manifest;

describe('manifest least-privilege invariants', () => {
  it('retains exactly the approved permission set', () => {
    const expected = [
      'activeTab',
      'debugger',
      'identity',
      'sidePanel',
      'storage',
      'tabs',
      'webNavigation',
    ];
    expect([...(manifest.permissions ?? [])].sort()).toStrictEqual([...expected].sort());
  });

  it('does not request scripting (removed as unused)', () => {
    expect(manifest.permissions).not.toContain('scripting');
  });

  it('keeps activeTab as the static host-access grant', () => {
    expect(manifest.permissions).toContain('activeTab');
  });

  it('declares <all_urls> only as opt-in optional_host_permissions, never static', () => {
    expect(manifest.optional_host_permissions?.includes('<all_urls>')).toBe(true);
    expect(manifest.host_permissions?.includes('<all_urls>')).toBe(false);
    expect(manifest.permissions?.includes('<all_urls>')).toBe(false);
  });

  it('has no static broad/grant-all host permission other than the two named endpoints', () => {
    const expected = ['https://glitchtip.infra.developerz.ai/*', 'https://openrouter.ai/*'];
    expect([...(manifest.host_permissions ?? [])].sort()).toStrictEqual([...expected].sort());
  });
});
