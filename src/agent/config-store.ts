// SW single source for the active provider configuration. The non-secret fields
// (baseURL, model, label) live plaintext in chrome.storage.local; the apiKey is split
// out to the encrypted named-secret key-store (SW-only decrypt) under
// `provider:<id>:key`. SW-ONLY — imports key-store; never import this from content.ts.
// See docs/architecture/security.md "Key custody".

import { ProviderConfig } from '@/shared/messages';
import {
  clearSecret,
  decryptSecret,
  type EncryptedPayload,
  getSecret,
  hasSecret,
  setSecret,
} from './key-store';

// ProviderConfig is the bus vocabulary (src/shared/messages.ts) — imported rather than
// redefined here so the SW-persisted shape and the panel<->SW wire shape can never drift.
export { ProviderConfig };

// One provider slot for this slice; the `<id>` segment leaves room for named providers
// later (the key-store is already name-parametrized). The secret name matches the
// key-store's default slot, so a key saved via the legacy OpenRouter shim reads back
// here unchanged.
const PROVIDER_ID = 'default';
const KEY_SECRET = `provider:${PROVIDER_ID}:key`;
const CONFIG_KEY = 'provider:config'; // plaintext, non-secret fields

// OpenRouter is the preset the legacy key-only flow implied; a migrated install lands here.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// Pre-refactor storage keys: the OpenRouter key was a bare payload under `openrouter-key`
// (before the named-secret `secret:` namespace), and the model id under `selected-model`.
const LEGACY_KEY_STORAGE = 'openrouter-key';
const LEGACY_MODEL_STORAGE = 'selected-model';

// The plaintext subset persisted to storage.local (apiKey stripped). Its own schema so a
// corrupt or legacy record is rejected on read rather than trusted.
const StoredConfig = ProviderConfig.omit({ apiKey: true });

/** Persist a provider config: non-secret fields plaintext, apiKey to the key-store. A
 *  missing/empty apiKey leaves any existing stored key intact — the panel shows a
 *  presence-only placeholder, so a re-save that only changes the model needn't re-enter
 *  the key. */
export async function saveProviderConfig(cfg: ProviderConfig): Promise<void> {
  const { apiKey, ...rest } = ProviderConfig.parse(cfg);
  await chrome.storage.local.set({ [CONFIG_KEY]: rest });
  if (apiKey) await setSecret(KEY_SECRET, apiKey);
}

/** Read the active config: plaintext fields + the decrypted apiKey (omitted if unset).
 *  Null when nothing valid is stored. */
export async function getProviderConfig(): Promise<ProviderConfig | null> {
  const got = await chrome.storage.local.get(CONFIG_KEY);
  const parsed = StoredConfig.safeParse(got[CONFIG_KEY]);
  if (!parsed.success) return null;
  const apiKey = await getSecret(KEY_SECRET);
  return apiKey === null ? parsed.data : { ...parsed.data, apiKey };
}

/** Whether a valid non-secret config is stored (without decrypting the key). */
export async function hasProviderConfig(): Promise<boolean> {
  const got = await chrome.storage.local.get(CONFIG_KEY);
  return StoredConfig.safeParse(got[CONFIG_KEY]).success;
}

/** Whether an apiKey is stored for the provider (without decrypting it). */
export function hasProviderKey(): Promise<boolean> {
  return hasSecret(KEY_SECRET);
}

/** Forget the config and its stored key. */
export async function clearProviderConfig(): Promise<void> {
  await chrome.storage.local.remove(CONFIG_KEY);
  await clearSecret(KEY_SECRET);
}

/**
 * One-shot migration of a pre-ProviderConfig OpenRouter install. Ports the encrypted key
 * out of the bare `openrouter-key` slot into the named-secret slot this store reads, and —
 * if a model was selected under the old key-only flow — seeds an OpenRouter-preset config so
 * the migrated key is usable without re-entry. Idempotent: a no-op once the legacy record is
 * gone, and it never clobbers a key/config the user already has under the new scheme. Run
 * once at service-worker startup (background.ts). See docs/architecture/security.md.
 */
export async function migrateLegacyProvider(): Promise<void> {
  const got = await chrome.storage.local.get([LEGACY_KEY_STORAGE, LEGACY_MODEL_STORAGE]);
  const legacy = got[LEGACY_KEY_STORAGE] as EncryptedPayload | undefined;
  if (legacy == null) return; // nothing legacy to migrate (fresh install or already ported)

  // Move the key only if the new slot is empty — never overwrite a re-entered key. The
  // wrapping key survives the refactor (it lives in IndexedDB), so the old ciphertext still
  // decrypts; re-encrypting under the new name keeps this on the public key-store API.
  if (!(await hasProviderKey())) {
    try {
      await setSecret(KEY_SECRET, await decryptSecret(legacy));
    } catch {
      // Corrupt / undecryptable legacy payload: drop it below rather than retry forever.
    }
  }

  // Seed a config from the legacy selected model so the key is immediately usable. Skip when
  // a config already exists (new scheme wins) or no model was ever picked (the key persists;
  // the user completes the config by choosing a model).
  const model = got[LEGACY_MODEL_STORAGE];
  if (typeof model === 'string' && model.length > 0 && !(await hasProviderConfig())) {
    await chrome.storage.local.set({
      [CONFIG_KEY]: StoredConfig.parse({
        baseURL: OPENROUTER_BASE_URL,
        model,
        label: 'OpenRouter',
      }),
    });
  }

  // Retire the legacy records so this runs exactly once.
  await chrome.storage.local.remove([LEGACY_KEY_STORAGE, LEGACY_MODEL_STORAGE]);
}
