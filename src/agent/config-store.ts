// SW single source for the active provider configuration. The non-secret fields
// (baseURL, model, label) live plaintext in chrome.storage.local; the apiKey is split
// out to the encrypted named-secret key-store (SW-only decrypt) under
// `provider:<id>:key`. SW-ONLY — imports key-store; never import this from content.ts.
// See docs/architecture/security.md "Key custody".

import { ProviderConfig } from '@/shared/messages';
import { clearSecret, getSecret, hasSecret, setSecret } from './key-store';

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
