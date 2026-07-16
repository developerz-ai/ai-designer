import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { confirmByEmail, countConfirmed, unsubscribeByEmail, upsertPending } from './db';
import { verifyCaptcha } from './hcaptcha';
import { sendConfirm, sendNotify, sendWelcome } from './mail';
import { signToken, verifyToken } from './token';

// Public POST endpoints (subscribe) + the count endpoint answer CORS preflight
// for the landing origin only.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'https://designer.developerz.ai';
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? 'http://localhost:3000';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (s: string): boolean => EMAIL_RE.test(s) && s.length <= 320;

export const app = new Hono();

app.use(
  '*',
  cors({
    origin: CORS_ORIGIN,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
);

app.get('/healthz', (c) => c.text('ok', 200));

app.get('/count', async (c) => {
  const count = await countConfirmed();
  return c.json({ count });
});

interface SubscribeBody {
  email?: string;
  captchaToken?: string;
  consent?: string;
}

app.post('/subscribe', async (c) => {
  const body = (await c.req.json().catch(() => null)) as SubscribeBody | null;
  if (!body?.email || !validEmail(body.email)) return c.json({ error: 'invalid email' }, 400);
  if (!body.captchaToken) return c.json({ error: 'captcha required' }, 400);
  if (body.consent !== 'true') return c.json({ error: 'consent required' }, 400);
  if (!(await verifyCaptcha(body.captchaToken))) return c.json({ error: 'captcha failed' }, 400);

  const token = signToken(body.email);
  const status = await upsertPending(body.email, token);
  if (status === 'confirmed') {
    // Already confirmed — never resend, never downgrade.
    return c.json({ ok: true, alreadySubscribed: true });
  }
  // status === 'pending' — new signup OR an existing pending row (resend).
  await sendConfirm(body.email, `${PUBLIC_BASE}/confirm?token=${token}`);
  return c.json({ ok: true });
});

app.get('/confirm', async (c) => {
  const token = c.req.query('token') ?? '';
  const result = verifyToken(token);
  if (!result.ok) return c.text(result.reason === 'expired' ? 'link expired' : 'invalid link', 400);
  const newlyConfirmed = await confirmByEmail(result.email);
  if (newlyConfirmed) {
    await sendWelcome(result.email);
    await sendNotify(result.email);
  }
  return c.redirect(`${CORS_ORIGIN}/?subscribed=1`);
});

app.get('/unsubscribe', async (c) => {
  const token = c.req.query('token') ?? '';
  const result = verifyToken(token);
  if (!result.ok) return c.text(result.reason === 'expired' ? 'link expired' : 'invalid link', 400);
  await unsubscribeByEmail(result.email);
  return c.text('unsubscribed — you will not receive further emails');
});

// Start the server only when run directly (not when imported by tests).
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: app.fetch });
  console.info(`designer-waitlist listening on :${port}`);
}

export default app;
