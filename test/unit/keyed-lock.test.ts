import { describe, expect, it } from 'vitest';
import { withKeyLock } from '@/mcp/keyed-lock';

// mcp/keyed-lock unit: per-key FIFO serialization for the storage read-modify-write writers.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('withKeyLock', () => {
  it('runs same-key work one at a time, in call order', async () => {
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([withKeyLock('k', job('a')), withKeyLock('k', job('b'))]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not serialize different keys', async () => {
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([withKeyLock('x', job('a')), withKeyLock('y', job('b'))]);
    expect(log.slice(0, 2)).toEqual(['a:start', 'b:start']);
  });

  it('a rejected job rejects its caller but the next job still runs', async () => {
    const failed = withKeyLock('k', async () => {
      throw new Error('boom');
    });
    const next = withKeyLock('k', async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });
});
