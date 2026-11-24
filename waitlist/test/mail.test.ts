import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The transport is created lazily and cached at module scope, so every test gets
// a fresh module (vi.resetModules + dynamic import) pointed at this stub. Nothing
// here opens an SMTP connection: the assertion target is the message object that
// sendNotify hands to sendMail.
const nodemailer = vi.hoisted(() => ({
  createTransport: vi.fn(() => ({ sendMail: nodemailer.sendMail })),
  sendMail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: nodemailer.createTransport },
  createTransport: nodemailer.createTransport,
}));

const ENV_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'NOTIFY_EMAIL',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.SMTP_HOST = 'mx.example.test';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'bot@example.test';
  process.env.SMTP_PASS = 'unused-in-tests';
  process.env.SMTP_FROM = 'waitlist@example.test';
  process.env.NOTIFY_EMAIL = 'team@example.test';
  nodemailer.createTransport.mockClear();
  nodemailer.sendMail.mockClear();
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface SentMessage {
  to: string;
  html: string;
  text: string;
}

/** The single message sendMail received, or a clear failure if none did. */
function sent(): SentMessage {
  expect(nodemailer.sendMail).toHaveBeenCalledTimes(1);
  const first = nodemailer.sendMail.mock.calls[0];
  return (first?.[0] ?? {}) as SentMessage;
}

describe('sendNotify', () => {
  it('encodes the five HTML-significant characters in the html field', async () => {
    const { sendNotify } = await import('../src/mail');
    await sendNotify('a&b<c>d"e\'f@example.com');
    expect(sent().html).toBe(
      '<p>New confirmed signup: <code>a&amp;b&lt;c&gt;d&quot;e&#39;f@example.com</code></p>',
    );
  });

  it('keeps the raw address in the plain-text alternative', async () => {
    const { sendNotify } = await import('../src/mail');
    const address = 'a&b<c>d"e\'f@example.com';
    await sendNotify(address);
    expect(sent().text).toBe(`New confirmed signup: ${address}`);
  });

  it('renders a tag-closing payload as inert entity text only', async () => {
    const { sendNotify } = await import('../src/mail');
    const payload = '</code><img src=x onerror="alert(1)">';
    await sendNotify(payload);
    const { html } = sent();
    // The value itself contributes no markup: its < and > are entities, so the
    // only real <code> pair in the document is the wrapper around it.
    expect(html).not.toContain('<img');
    expect(html).not.toContain(`</code>${payload}`);
    expect(html.split('<code>')).toHaveLength(2);
    expect(html.split('</code>')).toHaveLength(2);
    expect(html).toContain(
      '<code>&lt;/code&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</code>',
    );
  });

  it('sends nothing when NOTIFY_EMAIL is empty', async () => {
    process.env.NOTIFY_EMAIL = '';
    const { sendNotify } = await import('../src/mail');
    await sendNotify('user@example.com');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(nodemailer.sendMail).not.toHaveBeenCalled();
  });
});
