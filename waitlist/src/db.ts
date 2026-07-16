import postgres from 'postgres';

// postgres.js pool, created lazily so importing the module (e.g. in tests, where
// the whole module is mocked) never opens a connection. DATABASE_URL is the
// reflected CNPG secret (see infrastructure stacks/apps/designer-waitlist).

type Sql = ReturnType<typeof postgres>;

let _sql: Sql | null = null;

function sql(): Sql {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  _sql = postgres(url, { max: 5 });
  return _sql;
}

export type WaitlistStatus = 'pending' | 'confirmed' | 'unsubscribed';

interface StatusRow {
  status: WaitlistStatus;
}

interface CountRow {
  n: number;
}

/**
 * Upsert an email as pending with a fresh confirm token. Returns the resulting
 * status so the caller can branch:
 * - 'pending'   — new signup OR an existing pending row (resend the email)
 * - 'confirmed' — already confirmed; the caller must NOT resend or downgrade
 */
export async function upsertPending(email: string, confirmToken: string): Promise<WaitlistStatus> {
  const rows = await sql()`INSERT INTO waitlist (email, status, confirm_token)
    VALUES (${email}, 'pending', ${confirmToken})
    ON CONFLICT (email) DO UPDATE
      SET confirm_token = EXCLUDED.confirm_token,
          status = CASE WHEN waitlist.status = 'confirmed' THEN 'confirmed' ELSE 'pending' END
    RETURNING status`;
  const row = rows[0] as StatusRow | undefined;
  return row?.status ?? 'pending';
}

/**
 * Flip a pending row to confirmed. Returns true ONLY when a row actually
 * transitioned pending -> confirmed (so welcome + notify fire exactly once).
 */
export async function confirmByEmail(email: string): Promise<boolean> {
  const rows = await sql()`UPDATE waitlist
    SET status = 'confirmed', confirmed_at = now()
    WHERE email = ${email} AND status = 'pending'
    RETURNING email`;
  return rows.length > 0;
}

/** Confirmed subscribers only — pending signups never inflate the count. */
export async function countConfirmed(): Promise<number> {
  const rows = await sql()`SELECT count(*)::int AS n FROM waitlist WHERE status = 'confirmed'`;
  const row = rows[0] as CountRow | undefined;
  return row?.n ?? 0;
}

export async function unsubscribeByEmail(email: string): Promise<void> {
  await sql()`UPDATE waitlist
    SET status = 'unsubscribed', unsubscribed_at = now()
    WHERE email = ${email}`;
}
