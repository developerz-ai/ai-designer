import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: smtp.createTransport },
}));

beforeEach(() => {
  vi.resetModules();
  smtp.sendMail.mockReset().mockResolvedValue({});
  smtp.createTransport.mockReset().mockReturnValue({ sendMail: smtp.sendMail });
  vi.stubEnv('SMTP_HOST', 'smtp.example.test');
  vi.stubEnv('SMTP_PORT', '465');
  vi.stubEnv('SMTP_USER', 'test-user');
  vi.stubEnv('SMTP_PASS', 'test-password');
  vi.stubEnv('SMTP_FROM', 'waitlist@example.test');
  vi.stubEnv('NOTIFY_EMAIL', 'team@example.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendNotify', () => {
  it.each([
    ['ampersand', 'a&b@example.test', 'a&amp;b@example.test'],
    ['less-than', 'a<b@example.test', 'a&lt;b@example.test'],
    ['greater-than', 'a>b@example.test', 'a&gt;b@example.test'],
    ['double quote', 'a"b@example.test', 'a&quot;b@example.test'],
    ['apostrophe', "a'b@example.test", 'a&#39;b@example.test'],
    [
      'markup breakout',
      '</code><img src=x onerror="alert(1)">',
      '&lt;/code&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    ],
    [
      'entity-like input',
      '&lt;script&gt;&#39;&amp;',
      '&amp;lt;script&amp;gt;&amp;#39;&amp;amp;',
    ],
    ['ordinary address', 'alice+waitlist@example.test', 'alice+waitlist@example.test'],
  ])('encodes %s only in HTML, preserving plain text and routing', async (_, subscriber, encoded) => {
    const { sendNotify } = await import('../src/mail');

    await sendNotify(subscriber);

    expect(smtp.createTransport).toHaveBeenCalledTimes(1);
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: 'waitlist@example.test',
      to: 'team@example.test',
      subject: 'New designer waitlist signup',
      text: `New confirmed signup: ${subscriber}`,
      html: `<p>New confirmed signup: <code>${encoded}</code></p>`,
    });
  });

  it('does not create a transport or send when NOTIFY_EMAIL is absent', async () => {
    vi.stubEnv('NOTIFY_EMAIL', undefined);
    const { sendNotify } = await import('../src/mail');

    await sendNotify('alice@example.test');

    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
});
