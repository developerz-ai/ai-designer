import { createHmac, timingSafeEqual } from 'node:crypto';

// Confirm/unsubscribe tokens are HMAC-SHA256 over a base64url JSON payload
// `{email, iat}`. The signature is constant-time compared. A token is valid for
// MAX_AGE (30 days) from iat. TOKEN_SECRET is read at call-time so tests can set
// it per-run; a missing secret at runtime is a deployment misconfiguration.

export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface ConfirmPayload {
  email: string;
  iat: number;
}

function secret(): string {
  const s = process.env.TOKEN_SECRET;
  if (!s) throw new Error('TOKEN_SECRET is not set');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function signToken(email: string, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email, iat: now })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid' | 'expired' };

export function verifyToken(token: string, now: number = Date.now()): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid' };
  const [payload, sig] = parts as [string, string];
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: ConfirmPayload;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ConfirmPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof parsed.email !== 'string' || typeof parsed.iat !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  if (now - parsed.iat > MAX_AGE_MS) return { ok: false, reason: 'expired' };
  return { ok: true, email: parsed.email };
}
