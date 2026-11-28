import { describe, expect, it, vi } from 'vitest';
import { relayPickerCmd } from '@/agent/picker-relay';

// picker-relay unit: a failed PickerCmd send used to be swallowed into `{ ok: true }`, so the
// panel's ok-checks were dead and the picker looked armed on a page that could never pick.

describe('relayPickerCmd', () => {
  it('acks ok when the content script took the command', async () => {
    const send = vi.fn(async () => undefined);
    expect(await relayPickerCmd(send, 7, { type: 'picker-start' })).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(7, { type: 'picker-start' });
  });

  it('reports a tab with no content script as an actionable failure', async () => {
    const send = vi.fn(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const r = await relayPickerCmd(send, 7, { type: 'picker-start' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Reload the page');
  });

  it('reports any other send failure with its reason', async () => {
    const send = vi.fn(async () => {
      throw new Error('No tab with id: 7');
    });
    const r = await relayPickerCmd(send, 7, { type: 'picker-select', value: '#cta' });
    expect(r).toEqual({
      ok: false,
      error: 'The element picker could not reach this page: Error: No tab with id: 7',
    });
  });
});
