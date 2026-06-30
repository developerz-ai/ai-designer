// Secret custody for the service worker. A non-extractable AES-GCM-256 "wrapping
// key" lives in IndexedDB (extension origin, SW-reachable, never exportable by JS);
// the OpenRouter key is encrypted with it and the {iv, ciphertext} pair (base64)
// lives in chrome.storage.local. Decrypt is SW-only. The raw key bytes can never
// leave JS. See docs/architecture/security.md "Key custody".
//
// SW-ONLY: never import this from content.ts or the page world.

export type EncryptedPayload = { iv: string; ciphertext: string };

const DB_NAME = 'dz-designer';
const STORE = 'keys';
const KEY_ID = 'wrapping-key';
const STORAGE_KEY = 'openrouter-key';
const IV_BYTES = 12; // AES-GCM standard nonce length

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

// --- chrome.storage.local persistence (thin) -----------------------------

/** Encrypt + persist the OpenRouter API key. */
export async function setOpenRouterKey(plaintext: string): Promise<void> {
  const payload = await encryptSecret(plaintext);
  await chrome.storage.local.set({ [STORAGE_KEY]: payload });
}

/** Read + decrypt the OpenRouter API key, or null if unset. */
export async function getOpenRouterKey(): Promise<string | null> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const payload = got[STORAGE_KEY] as EncryptedPayload | undefined;
  return payload ? decryptSecret(payload) : null;
}

/** Whether a key is currently stored (without decrypting it). */
export async function hasOpenRouterKey(): Promise<boolean> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return got[STORAGE_KEY] != null;
}

/** Forget the stored key (the wrapping key is left in IndexedDB, unused). */
export async function clearOpenRouterKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
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
