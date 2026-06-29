import { createStore } from 'solid-js/store';
import {
  KeyStatusResult,
  type ModelOption,
  ModelsResult,
  OkResult,
  SaveKeyResult,
} from '@/shared/messages';
import { request } from './bus';

// Settings store: the single source of UI truth for the BYOK key + model picker.
// All service-worker dispatch happens in these actions so SettingsPanel stays
// render + dispatch only (CLAUDE.md "SolidJS + SRP"). The key value itself never
// lives here — only its presence + the selected model.

export type KeyStatusUi = 'unknown' | 'absent' | 'saving' | 'valid' | 'invalid';

interface SettingsState {
  apiKeyPresent: boolean;
  keyStatus: KeyStatusUi;
  selectedModel: string | null;
  models: ModelOption[];
  modelsLoading: boolean;
  error: string | null;
}

const [settings, set] = createStore<SettingsState>({
  apiKeyPresent: false,
  keyStatus: 'unknown',
  selectedModel: null,
  models: [],
  modelsLoading: false,
  error: null,
});

export { settings };

/** Load presence + selected model on mount; pull the model list if a key exists. */
export async function hydrate(): Promise<void> {
  try {
    const r = await request({ type: 'key-status' }, KeyStatusResult);
    set({
      apiKeyPresent: r.present,
      selectedModel: r.model ?? null,
      keyStatus: r.present ? 'valid' : 'absent',
    });
    if (r.present) await loadModels();
  } catch (e) {
    set({ keyStatus: 'absent', error: errMsg(e) });
  }
}

/** Validate + persist a key (SW-side); refresh the model list on success. */
export async function saveKey(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  set({ keyStatus: 'saving', error: null });
  try {
    const r = await request({ type: 'save-openrouter-key', text: trimmed }, SaveKeyResult);
    set({
      keyStatus: r.valid ? 'valid' : 'invalid',
      apiKeyPresent: r.valid,
      error: r.valid ? null : (r.error ?? 'Key rejected by OpenRouter.'),
    });
    if (r.valid) await loadModels();
  } catch (e) {
    set({ keyStatus: 'invalid', error: errMsg(e) });
  }
}

export async function loadModels(): Promise<void> {
  set({ modelsLoading: true, error: null });
  try {
    const r = await request({ type: 'list-models' }, ModelsResult);
    set({ models: r.models ?? [], error: r.error ?? null });
  } catch (e) {
    set({ error: errMsg(e) });
  } finally {
    set({ modelsLoading: false });
  }
}

export async function selectModel(model: string): Promise<void> {
  set('selectedModel', model); // optimistic
  try {
    await request({ type: 'set-model', model }, OkResult);
  } catch (e) {
    set({ error: errMsg(e) });
  }
}

export async function clearKey(): Promise<void> {
  try {
    await request({ type: 'clear-openrouter-key' }, OkResult);
  } catch (e) {
    set({ error: errMsg(e) });
    return;
  }
  set({ apiKeyPresent: false, keyStatus: 'absent', selectedModel: null, models: [] });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
