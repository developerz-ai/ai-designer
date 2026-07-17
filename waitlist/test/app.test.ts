import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock objects so vi.mock factories can reference them. The app imports
// db/mail/hcaptcha as values; we replace each with stubs so no DB/SMTP/network
// is touched.
const db = vi.hoisted(() => ({
  upsertPending: vi.fn(),
  confirmByEmail: vi.fn(),
  countConfirmed: vi.fn(),
  unsubscribeByEmail: vi.fn(),
}));
const mail = vi.hoisted(() => ({
  sendConfirm: vi.fn(),
  sendWelcome: vi.fn(),
  sendNotify: vi.fn(),
}));
const captcha = vi.hoisted(() => ({ verifyCaptcha: vi.fn() }));

vi.mock('../src/db', () => db);
vi.mock('../src/mail', () => mail);
vi.mock('../src/hcaptcha', () => captcha);

import { app } from '../src/index';
import { signToken } from '../src/token';

beforeAll(() => {
  process.env.TOKEN_SECRET = 'test-secret-key';
  process.env.CORS_ORIGIN = 'https://designer.developerz.ai';
  process.env.PUBLIC_BASE = 'https://waitlist.developerz.ai';
});

beforeEach(() => {
  db.upsertPending.mockReset();
  db.confirmByEmail.mockReset();
  db.countConfirmed.mockReset();
  db.unsubscribeByEmail.mockReset();
  mail.sendConfirm.mockReset();
  mail.sendWelcome.mockReset();
  mail.sendNotify.mockReset();
  captcha.verifyCaptcha.mockReset();
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('GET /count', () => {
  it('returns the marketing seed plus the confirmed-only count', async () => {
    db.countConfirmed.mockResolvedValue(42);
    const res = await app.request('/count');
    expect(res.status).toBe(200);
    // 134 default seed floors the public number so an early real count never
    // reads as dead; real confirmed signups accumulate on top of the seed.
    expect(await res.json()).toEqual({ count: 134 + 42 });
    expect(db.countConfirmed).toHaveBeenCalledTimes(1);
  });

  it('shows the seed alone when there are no confirmed signups yet', async () => {
    db.countConfirmed.mockResolvedValue(0);
    const res = await app.request('/count');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 134 });
  });
});

describe('POST /subscribe', () => {
  const valid = { email: 'user@example.com', captchaToken: 'tok', consent: 'true' };

  it('400 on an invalid email', async () => {
    captcha.verifyCaptcha.mockResolvedValue(true);
    const res = await app.request('/subscribe', json({ ...valid, email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('400 when the captcha token is missing', async () => {
    const res = await app.request(
      '/subscribe',
      json({ email: 'user@example.com', consent: 'true' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when consent is not "true"', async () => {
    captcha.verifyCaptcha.mockResolvedValue(true);
    const res = await app.request('/subscribe', json({ ...valid, consent: 'no' }));
    expect(res.status).toBe(400);
  });

  it('400 when captcha verification fails (no DB write)', async () => {
    captcha.verifyCaptcha.mockResolvedValue(false);
    const res = await app.request('/subscribe', json(valid));
    expect(res.status).toBe(400);
    expect(db.upsertPending).not.toHaveBeenCalled();
  });

  it('sends a confirmation email for a pending signup (new OR resend)', async () => {
    captcha.verifyCaptcha.mockResolvedValue(true);
    db.upsertPending.mockResolvedValue('pending');
    const res = await app.request('/subscribe', json(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.upsertPending).toHaveBeenCalledWith('user@example.com', expect.any(String));
    expect(mail.sendConfirm).toHaveBeenCalledTimes(1);
  });

  it('does NOT resend for an already-confirmed email', async () => {
    captcha.verifyCaptcha.mockResolvedValue(true);
    db.upsertPending.mockResolvedValue('confirmed');
    const res = await app.request('/subscribe', json(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadySubscribed: true });
    expect(mail.sendConfirm).not.toHaveBeenCalled();
  });
});

describe('CORS preflight', () => {
  it('answers OPTIONS for the landing origin', async () => {
    const res = await app.request('/subscribe', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://designer.developerz.ai',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://designer.developerz.ai');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('GET /confirm', () => {
  it('confirms a valid token, fires welcome + notify, redirects to the landing', async () => {
    const token = signToken('user@example.com');
    db.confirmByEmail.mockResolvedValue(true); // newly confirmed
    const res = await app.request(`/confirm?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('designer.developerz.ai');
    expect(mail.sendWelcome).toHaveBeenCalledTimes(1);
    expect(mail.sendNotify).toHaveBeenCalledTimes(1);
  });

  it('does NOT send welcome/notify for an already-confirmed email', async () => {
    const token = signToken('user@example.com');
    db.confirmByEmail.mockResolvedValue(false); // already confirmed / not found
    const res = await app.request(`/confirm?token=${token}`);
    expect(res.status).toBe(302);
    expect(mail.sendWelcome).not.toHaveBeenCalled();
    expect(mail.sendNotify).not.toHaveBeenCalled();
  });

  it('400 on an invalid token', async () => {
    const res = await app.request('/confirm?token=bogus');
    expect(res.status).toBe(400);
  });
});

describe('GET /unsubscribe', () => {
  it('unsubscribes a valid token', async () => {
    const token = signToken('user@example.com');
    const res = await app.request(`/unsubscribe?token=${token}`);
    expect(res.status).toBe(200);
    expect(db.unsubscribeByEmail).toHaveBeenCalledWith('user@example.com');
  });

  it('400 on an invalid token', async () => {
    const res = await app.request('/unsubscribe?token=bogus');
    expect(res.status).toBe(400);
  });
});
