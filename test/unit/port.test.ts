import { describe, expect, it } from 'vitest';
import { PORT_NAME, parseSwToPanel } from '@/shared/port';

describe('port (SW -> panel Port validation)', () => {
  it('exposes a non-empty PORT_NAME constant', () => {
    expect(PORT_NAME).toBe('dz-sw-panel');
  });

  it('parses a valid SwToPanel focus message', () => {
    const r = parseSwToPanel({
      type: 'focus',
      selector: { value: '#cta', strategy: 'id', fragile: false },
      rect: { x: 1, y: 2, width: 10, height: 20 },
    });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.type).toBe('focus');
  });

  it('returns null for malformed input', () => {
    expect(parseSwToPanel({ type: 'totally-fake' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseSwToPanel('nope')).toBeNull();
    expect(parseSwToPanel(null)).toBeNull();
  });
});
