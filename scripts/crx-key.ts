// CRX signing identity — one source of truth for the key the build is prepared with.
//
// The extension ID is sha256(SPKI public key). Pin the public key in the manifest
// (`key`) and the ID stops drifting between an unpacked dev build, a .crx, and a
// store listing. That matters beyond tidiness: MCP OAuth redirects through
// `chrome.identity.getRedirectURL()` → https://<extension-id>.chromiumapp.org/,
// a URL that has to be registered with the provider ahead of time (src/mcp/auth.ts).
//
// Resolution order matches scripts/pack-crx.sh, so the manifest `key` and the .crx
// signature always come from the same private key — Chrome refuses to install a .crx
// whose signature disagrees with the manifest `key`.
//   1. $CRX_PUBLIC_KEY   — base64 SPKI DER, public half only (enough to pin the ID).
//   2. $CRX_PRIVATE_KEY  — PEM contents (CI secret).
//   3. $CRX_KEY_PATH     — path to a PEM.
//   4. keys/designer.pem — local default, generated on first build.
//
// CLI: `bun scripts/crx-key.ts` → id + public key. `--id` / `--key` print one value.
// `--ensure` generates the local PEM if missing — run before `wxt build` so the very
// first build already carries its `key`, instead of only the second one.

import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_KEY_PATH = 'keys/designer.pem';

/** The signing PEM, or null when this checkout has no key yet. */
export function readPrivateKeyPem(): string | null {
  const inline = process.env.CRX_PRIVATE_KEY;
  if (inline) return inline;
  const path = process.env.CRX_KEY_PATH ?? DEFAULT_KEY_PATH;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Base64 SPKI DER — the exact shape Chrome's manifest `key` field expects. */
export function publicKeyBase64(): string | null {
  const inline = process.env.CRX_PUBLIC_KEY;
  if (inline) return inline.trim();
  const pem = readPrivateKeyPem();
  if (!pem) return null;
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Chrome's ID derivation: first 16 bytes of sha256(DER), hex, digits mapped 0-f → a-p. */
export function extensionId(spkiBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest();
  return Array.from(digest.subarray(0, 16))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

/**
 * Guarantee a signing key exists, generating the local PEM on first run.
 * No-ops when the key comes from the environment — CI must never write a secret to disk.
 * Returns the path written, or null when nothing was generated.
 */
export function ensurePrivateKey(): string | null {
  if (process.env.CRX_PUBLIC_KEY || process.env.CRX_PRIVATE_KEY) return null;
  const path = process.env.CRX_KEY_PATH ?? DEFAULT_KEY_PATH;
  if (existsSync(path)) return null;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096, // matches what crx3 generates, so a regenerated key is the same shape
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey, { mode: 0o600 });
  return path;
}

if (import.meta.main) {
  const flag = process.argv[2];

  if (flag === '--ensure') {
    const created = ensurePrivateKey();
    if (created) {
      console.warn(
        `\x1b[1;33m! generated a signing key at ${created} — back it up; it defines the extension ID\x1b[0m`,
      );
    }
  }

  const key = publicKeyBase64();
  if (!key) {
    console.error(`no signing key — run \`bun run crx:key\` to generate ${DEFAULT_KEY_PATH}`);
    process.exit(1);
  }

  if (flag === '--id') console.log(extensionId(key));
  else if (flag === '--key') console.log(key);
  else if (flag !== '--ensure') {
    console.log(`id:  ${extensionId(key)}`);
    console.log(`key: ${key}`);
  }
}
