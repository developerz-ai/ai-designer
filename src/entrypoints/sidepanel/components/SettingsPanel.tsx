import { For, onMount, Show } from 'solid-js';
import {
  clearProvider,
  hydrate,
  loadModels,
  PRESETS,
  type ProviderPreset,
  pickModel,
  saveProvider,
  selectPreset,
  setCustomBaseURL,
  settings,
} from '../stores/settings';
import { AboutSection } from './AboutSection';
import './SettingsPanel.scss';

// Render + dispatch only — no fetch, no crypto, no chrome.*. All logic lives in
// ../stores/settings (which talks to the service worker). The key input is never
// echoed back: it's a password field and the placeholder reflects presence, not
// the value (CLAUDE.md "MV3 three worlds" — the key never leaves the SW world).
export function SettingsPanel() {
  let keyInput!: HTMLInputElement;
  onMount(() => {
    void hydrate();
  });

  function statusText(): string {
    switch (settings.saveStatus) {
      case 'valid':
        return 'Provider saved and reachable.';
      case 'invalid':
        return settings.error ?? 'Provider rejected the config.';
      case 'saving':
        return 'Validating…';
      default:
        return settings.hasKey ? 'Key saved.' : 'No key set — add one to connect.';
    }
  }

  return (
    <div class="dz-settings">
      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-preset">
          Provider
        </label>
        <div class="dz-settings__presetrow">
          <select
            id="dz-preset"
            value={settings.preset}
            onChange={(e) => selectPreset(e.currentTarget.value as ProviderPreset)}
          >
            <For each={PRESETS}>{(p) => <option value={p.id}>{p.label}</option>}</For>
          </select>
        </div>
        <Show when={settings.preset === 'custom'}>
          <input
            class="dz-settings__url"
            type="url"
            placeholder="https://api.example.com/v1"
            value={settings.baseURL}
            onInput={(e) => setCustomBaseURL(e.currentTarget.value)}
          />
        </Show>
      </section>

      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-key">
          API key
        </label>
        <div class="dz-settings__keyrow">
          <input
            id="dz-key"
            ref={keyInput}
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder={settings.hasKey ? 'saved — paste to replace' : 'sk-...'}
          />
          <Show when={settings.hasKey}>
            <button type="button" class="dz-settings__ghost" onClick={() => void clearProvider()}>
              Clear
            </button>
          </Show>
        </div>
      </section>

      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-model">
          Model
        </label>
        <div class="dz-settings__modelrow">
          <select
            id="dz-model"
            disabled={settings.modelsLoading}
            onChange={(e) => pickModel(e.currentTarget.value)}
          >
            <For each={settings.models}>
              {(m) => (
                <option value={m.id} selected={m.id === settings.model}>
                  {m.name}
                </option>
              )}
            </For>
          </select>
          <button
            type="button"
            disabled={settings.modelsLoading}
            onClick={() => void loadModels(keyInput.value)}
          >
            Refresh
          </button>
        </div>
        <p class="dz-settings__hint">Pick a vision-capable model; cost varies per model.</p>
      </section>

      <section class="dz-settings__section">
        <button
          type="button"
          class="dz-settings__save"
          disabled={settings.saveStatus === 'saving' || !settings.model}
          onClick={() => {
            void saveProvider(keyInput.value, settings.model ?? '').then(() => {
              keyInput.value = '';
            });
          }}
        >
          Save
        </button>
        <p
          class="dz-settings__status"
          classList={{
            'is-ok': settings.saveStatus === 'valid',
            'is-bad': settings.saveStatus === 'invalid',
          }}
        >
          {statusText()}
        </p>
      </section>

      <AboutSection />
    </div>
  );
}
