import { createStore } from 'solid-js/store';
import { ensureHostAccess } from '@/shared/host-permissions';
import {
  GetProviderResult,
  type ModelOption,
  ModelsResult,
  OkResult,
  SaveProviderResult,
} from '@/shared/messages';
import { request } from './bus';

// Settings store: the single source of UI truth for the provider config (base URL +
// BYOK key + model). All service-worker dispatch happens in these actions so
// SettingsPanel stays render + dispatch only (CLAUDE.md "SolidJS + SRP"). The key
// value itself never lives here — it's typed in the panel and crosses panel->SW once
// per save/refresh call, never persisted to this store (CLAUDE.md "MV3 three worlds").

export type ProviderPreset = 'openrouter' | 'openai' | 'custom';
export type SaveStatus = 'idle' | 'saving' | 'valid' | 'invalid';

interface PresetDef {
  id: ProviderPreset;
  label: string;
  baseURL: string | null; // null = user-entered (custom)
}

// Ordered for the dropdown. `baseURL: null` (custom) is the fallback when a saved
// config's baseURL doesn't match a known preset.
export const PRESETS: PresetDef[] = [
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
  { id: 'custom', label: 'Custom', baseURL: null },
];

interface SettingsState {
  preset: ProviderPreset;
  baseURL: string;
  // The baseURL a config was last successfully persisted under. Used to tell whether
  // a `list-models` refresh can rely on the SW's saved (decrypted) key or must carry
  // an explicit, not-yet-saved endpoint.
  savedBaseURL: string | null;
  hasKey: boolean;
  model: string | null;
  models: ModelOption[];
  modelsLoading: boolean;
  saveStatus: SaveStatus;
  error: string | null;
}

// PRESETS is a non-empty literal above; the fallback here only satisfies
// noUncheckedIndexedAccess, it never actually applies.
const firstPreset: PresetDef = PRESETS[0] ?? {
  id: 'openrouter',
  label: 'OpenRouter',
  baseURL: null,
};

const [settings, set] = createStore<SettingsState>({
  preset: firstPreset.id,
  baseURL: firstPreset.baseURL ?? '',
  savedBaseURL: null,
  hasKey: false,
  model: null,
  models: [],
  modelsLoading: false,
  saveStatus: 'idle',
  error: null,
});

export { settings };

function presetForBaseURL(baseURL: string): ProviderPreset {
  const match = PRESETS.find((p) => p.baseURL === baseURL);
  return match?.id ?? 'custom';
}

/** Load the saved config (if any) + key presence on mount; pull the model list when a
 *  key is already stored. */
export async function hydrate(): Promise<void> {
  try {
    const r = await request({ type: 'get-provider' }, GetProviderResult);
    if (r.config) {
      set({
        preset: presetForBaseURL(r.config.baseURL),
        baseURL: r.config.baseURL,
        savedBaseURL: r.config.baseURL,
        model: r.config.model,
        hasKey: r.hasKey ?? false,
      });
    } else {
      set({ hasKey: r.hasKey ?? false });
    }
    if (r.hasKey) await loadModels();
  } catch (e) {
    set({ error: errMsg(e) });
  }
}

/** Switch preset: known presets fill in the base URL immediately; Custom leaves the
 *  current value editable. The model list is stale for the new endpoint until Refresh. */
export function selectPreset(preset: ProviderPreset): void {
  const def = PRESETS.find((p) => p.id === preset);
  set({
    preset,
    baseURL: def?.baseURL ?? settings.baseURL,
    models: [],
    model: null,
    saveStatus: 'idle',
    error: null,
  });
}

/** Custom-preset base URL edits (ignored for known presets — their URL is fixed). */
export function setCustomBaseURL(url: string): void {
  if (settings.preset !== 'custom') return;
  set({ baseURL: url, models: [], saveStatus: 'idle' });
}

/** Optimistic model pick from the dropdown; persisted together with the rest of the
 *  config on Save (there's no partial-save RPC — `save-provider` takes the full
 *  config, see src/shared/messages.ts). */
export function pickModel(model: string): void {
  set('model', model);
}

/** Fetch the model list for the current base URL. Reuses the SW's saved (decrypted)
 *  key when the base URL is unchanged from what's persisted; otherwise (a not-yet-saved
 *  endpoint, or a freshly typed key) carries an explicit endpoint so the panel can
 *  populate the dropdown before Save. */
export async function loadModels(apiKeyText?: string): Promise<void> {
  const typed = apiKeyText?.trim();
  const canUseSaved = !typed && settings.hasKey && settings.baseURL === settings.savedBaseURL;
  set({ modelsLoading: true, error: null });
  try {
    const r = await request(
      canUseSaved
        ? { type: 'list-models' }
        : { type: 'list-models', baseURL: settings.baseURL, apiKey: typed || undefined },
      ModelsResult,
    );
    set({ models: r.models ?? [], error: r.error ?? null });
  } catch (e) {
    set({ error: errMsg(e) });
  } finally {
    set({ modelsLoading: false });
  }
}

/** Validate + persist the full provider config (base URL + key + model). A blank key
 *  leaves any existing stored key intact (see config-store.ts). Re-hydrates afterward
 *  so `hasKey`/`savedBaseURL`/`model` reflect what the SW actually persisted, rather
 *  than guessing from the RPC result (a custom-host permission denial saves nothing).
 *
 *  A not-yet-granted custom host needs `chrome.permissions.request`, which only succeeds
 *  called synchronously within a live user gesture — it does NOT survive the hop across
 *  `chrome.runtime.sendMessage` to the service worker (see shared/host-permissions.ts). So
 *  the grant is requested here, inside the Save click, before the RPC ever goes out; the SW
 *  re-checks (a no-op once this has granted it) before persisting. */
export async function saveProvider(apiKeyText: string, model: string): Promise<void> {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    set({ error: 'Choose a model before saving.' });
    return;
  }
  const preset = PRESETS.find((p) => p.id === settings.preset);
  set({ saveStatus: 'saving', error: null });
  const access = await ensureHostAccess(settings.baseURL);
  if (!access.ok) {
    set({ saveStatus: 'invalid', error: access.error ?? 'Host access denied.' });
    return;
  }
  try {
    const r = await request(
      {
        type: 'save-provider',
        config: {
          baseURL: settings.baseURL,
          apiKey: apiKeyText.trim() || undefined,
          model: trimmedModel,
          label: preset && preset.id !== 'custom' ? preset.label : undefined,
        },
      },
      SaveProviderResult,
    );
    set({
      saveStatus: r.valid ? 'valid' : 'invalid',
      error: r.valid ? null : (r.error ?? 'Provider unreachable — saved anyway.'),
    });
    await hydrate();
  } catch (e) {
    set({ saveStatus: 'invalid', error: errMsg(e) });
  }
}

/** Composer's inline model quick-switch — persists immediately via the legacy
 *  `set-model` RPC (background.ts keeps the rest of the saved config, see its handler)
 *  rather than routing through the full `saveProvider` form flow. */
export async function switchModel(model: string): Promise<void> {
  const previous = settings.model;
  set({ model, error: null });
  try {
    await request({ type: 'set-model', model }, OkResult);
  } catch (e) {
    set({ model: previous, error: errMsg(e) });
  }
}

/** Forget the stored config + key entirely. */
export async function clearProvider(): Promise<void> {
  try {
    await request({ type: 'clear-openrouter-key' }, OkResult);
  } catch (e) {
    set({ error: errMsg(e) });
    return;
  }
  set({
    preset: firstPreset.id,
    baseURL: firstPreset.baseURL ?? '',
    savedBaseURL: null,
    hasKey: false,
    model: null,
    models: [],
    saveStatus: 'idle',
    error: null,
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
