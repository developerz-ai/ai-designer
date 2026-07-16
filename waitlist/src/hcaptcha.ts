// hCaptcha server-side siteverify. The secret lives server-side only; the site
// key is public (rendered on the landing). In tests this module is mocked so no
// network call is made.

const SITEVERIFY_URL = 'https://api.hcaptcha.com/siteverify';

export async function verifyCaptcha(token: string): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.HCAPTCHA_SECRET ?? '';
  const res = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ response: token, secret }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}
