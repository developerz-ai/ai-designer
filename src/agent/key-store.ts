// Secret custody for the service worker. A non-extractable AES-GCM-256 "wrapping
// key" lives in IndexedDB (extension origin, SW-reachable, never exportable by JS);
// named secrets are encrypted with it and each {iv, ciphertext} pair (base64) lives
// in chrome.storage.local under `secret:<name>`. Decrypt is SW-only. The raw key
// bytes can never leave JS. See docs/architecture/security.md "Key custody".
//
// SW-ONLY: never import this from content.ts or the page world.

export type EncryptedPayload = { iv: string; ciphertext: string };

const DB_NAME = 'dz-designer';
const STORE = 'keys';
const KEY_ID = 'wrapping-key';
const SECRET_PREFIX = 'secret:'; // namespaces encrypted secrets from plaintext config
const IV_BYTES = 12; // AES-GCM standard nonce length

/** chrome.storage.local key for a named secret (namespaced, greppable). */
function secret(name: string): string {
  return `${SECRET_PREFIX}${name}`;
}

// --- WebCrypto -----------------------------------------------------------

/** Load the wrapping key from IndexedDB, generating + persisting it on first use. */
export async function ensureWrappingKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // extractable=false -> raw bytes can never be exported by JS
    ['encrypt', 'decrypt'],
  );
  await idbPut(KEY_ID, key);
  return key;
}

/** Encrypt a UTF-8 secret with a fresh random 12-byte IV. */
export async function encryptSecret(plaintext: string): Promise<EncryptedPayload> {
  const key = await ensureWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(buf)) };
}

/** Decrypt a payload produced by encryptSecret back to its UTF-8 string. */
export async function decryptSecret(payload: EncryptedPayload): Promise<string> {
  const key = await ensureWrappingKey();
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(buf);
}

// --- named-secret persistence (chrome.storage.local, thin) ---------------

/** Encrypt + persist a named secret (e.g. `provider:default:key`). */
export async function setSecret(name: string, plaintext: string): Promise<void> {
  const payload = await encryptSecret(plaintext);
  await chrome.storage.local.set({ [secret(name)]: payload });
}

/** Read + decrypt a named secret, or null if unset. */
export async function getSecret(name: string): Promise<string | null> {
  const storageKey = secret(name);
  const got = await chrome.storage.local.get(storageKey);
  const payload = got[storageKey] as EncryptedPayload | undefined;
  return payload ? decryptSecret(payload) : null;
}

/** Whether a named secret is stored (without decrypting it). */
export async function hasSecret(name: string): Promise<boolean> {
  const storageKey = secret(name);
  const got = await chrome.storage.local.get(storageKey);
  return got[storageKey] != null;
}

/** Forget a named secret (the wrapping key is left in IndexedDB, unused). */
export async function clearSecret(name: string): Promise<void> {
  await chrome.storage.local.remove(secret(name));
}

// --- OpenRouter shims (default provider slot) ----------------------------
// Back-compat over the named-secret API; the default provider key lives under
// `provider:default:key`. Prefer setSecret/getSecret directly in new code.

const DEFAULT_PROVIDER_KEY = 'provider:default:key';

/** Encrypt + persist the default provider API key. */
export function setOpenRouterKey(plaintext: string): Promise<void> {
  return setSecret(DEFAULT_PROVIDER_KEY, plaintext);
}

/** Read + decrypt the default provider API key, or null if unset. */
export function getOpenRouterKey(): Promise<string | null> {
  return getSecret(DEFAULT_PROVIDER_KEY);
}

/** Whether the default provider key is currently stored (without decrypting it). */
export function hasOpenRouterKey(): Promise<boolean> {
  return hasSecret(DEFAULT_PROVIDER_KEY);
}

/** Forget the stored default provider key. */
export function clearOpenRouterKey(): Promise<void> {
  return clearSecret(DEFAULT_PROVIDER_KEY);
}

// --- base64 (works in the SW + Node; avoids Buffer) ----------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- raw IndexedDB (single keyval store, no external dep) -----------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key); // out-of-line key
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}
