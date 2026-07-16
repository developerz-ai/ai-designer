import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';

// Outbound mail via Stalwart SMTPS (mx.developerz.ai:465, implicit TLS). The
// transport is created lazily; in tests the whole module is mocked so no SMTP
// connection is ever opened. List-Unsubscribe is set on every message for
// Gmail/Yahoo one-click unsubscribe.

interface MailEnv {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  notify: string;
}

function env(): MailEnv {
  return {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? '465'),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? '',
    notify: process.env.NOTIFY_EMAIL ?? '',
  };
}

let _transport: Transporter | null = null;
function transport(): Transporter {
  if (_transport) return _transport;
  const e = env();
  _transport = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.port === 465, // implicit-TLS SMTPS; NOT STARTTLS/:587
    auth: { user: e.user, pass: e.pass },
  });
  return _transport;
}

const unsubscribeHeader = (from: string) => ({
  'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>`,
});

export async function sendConfirm(to: string, confirmUrl: string): Promise<void> {
  const { from } = env();
  await transport().sendMail({
    from,
    to,
    subject: 'Confirm your spot on the designer waitlist',
    text: `Confirm your spot: ${confirmUrl}`,
    html: `<p>You're one click away. Confirm your spot on the designer waitlist:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p>`,
    headers: unsubscribeHeader(from),
  });
}

export async function sendWelcome(to: string): Promise<void> {
  const { from } = env();
  await transport().sendMail({
    from,
    to,
    subject: "You're on the list",
    text: "You're confirmed on the designer waitlist. We'll email you at launch.",
    html: "<p>You're confirmed on the designer waitlist. We'll email you the moment designer.developerz.ai goes live.</p>",
    headers: unsubscribeHeader(from),
  });
}

/** Notify the team of a NEW confirmed signup. */
export async function sendNotify(subscriberEmail: string): Promise<void> {
  const { from, notify } = env();
  if (!notify) return;
  await transport().sendMail({
    from,
    to: notify,
    subject: 'New designer waitlist signup',
    text: `New confirmed signup: ${subscriberEmail}`,
    html: `<p>New confirmed signup: <code>${subscriberEmail}</code></p>`,
  });
}
