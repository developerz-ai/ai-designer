import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../src/token';

beforeAll(() => {
  process.env.TOKEN_SECRET = 'test-secret-key';
});
afterAll(() => {
  delete process.env.TOKEN_SECRET;
});

describe('token sign/verify', () => {
  it('round-trips a freshly signed token', () => {
    const now = Date.now();
    const t = signToken('user@example.com', now);
    expect(verifyToken(t, now)).toEqual({ ok: true, email: 'user@example.com' });
  });

  it('rejects a tampered signature', () => {
    const t = signToken('user@example.com');
    const [payload] = t.split('.') as [string, string];
    // 43 chars = base64url length of a sha256 HMAC; wrong content, right length.
    const tampered = `${payload}.${'A'.repeat(43)}`;
    expect(verifyToken(tampered)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects malformed tokens', () => {
    expect(verifyToken('garbage')).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken('a.b.c')).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken('')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an expired token (older than 30 days)', () => {
    const issued = Date.now();
    const t = signToken('user@example.com', issued);
    const thirtyOneDaysLater = issued + 31 * 24 * 60 * 60 * 1000;
    expect(verifyToken(t, thirtyOneDaysLater)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a token just under the 30-day ceiling', () => {
    const issued = Date.now();
    const t = signToken('user@example.com', issued);
    const twentyNineDays = issued + 29 * 24 * 60 * 60 * 1000;
    expect(verifyToken(t, twentyNineDays)).toEqual({ ok: true, email: 'user@example.com' });
  });
});
