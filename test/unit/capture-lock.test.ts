import { describe, expect, it } from 'vitest';
import { createCaptureLock } from '@/agent/capture-lock';

describe('createCaptureLock', () => {
  it('serializes contended runs per tab (FIFO)', async () => {
    const lock = createCaptureLock();
    const order: string[] = [];
    const slow = lock(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
      return 'a';
    });
    const fast = lock(1, async () => {
      order.push('fast');
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('stays alive after a rejected run — the caller sees the rejection, the chain continues', async () => {
    const lock = createCaptureLock();
    await expect(lock(1, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(lock(1, () => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('does not serialize across tabs', async () => {
    const lock = createCaptureLock();
    const order: string[] = [];
    const a = lock(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a');
    });
    const b = lock(2, async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });
});
