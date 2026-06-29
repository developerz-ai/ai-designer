import { For, onMount, Show } from 'solid-js';
import { clearKey, hydrate, loadModels, saveKey, selectModel, settings } from '../stores/settings';
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
    switch (settings.keyStatus) {
      case 'valid':
        return 'Key valid.';
      case 'invalid':
        return settings.error ?? 'Key rejected.';
      case 'saving':
        return 'Validating…';
      default:
        return settings.apiKeyPresent ? 'Key saved.' : 'No key set — add one to start.';
    }
  }

  return (
    <div class="dz-settings">
      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-or-key">
          OpenRouter API key
        </label>
        <form
          class="dz-settings__keyrow"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey(keyInput.value);
            keyInput.value = '';
          }}
        >
          <input
            id="dz-or-key"
            ref={keyInput}
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder={settings.apiKeyPresent ? 'saved — paste to replace' : 'sk-or-...'}
          />
          <button type="submit" disabled={settings.keyStatus === 'saving'}>
            Save
          </button>
          <Show when={settings.apiKeyPresent}>
            <button type="button" class="dz-settings__ghost" onClick={() => void clearKey()}>
              Clear
            </button>
          </Show>
        </form>
        <p
          class="dz-settings__status"
          classList={{
            'is-ok': settings.keyStatus === 'valid',
            'is-bad': settings.keyStatus === 'invalid',
          }}
        >
          {statusText()}
        </p>
      </section>

      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-or-model">
          Model
        </label>
        <div class="dz-settings__modelrow">
          <select
            id="dz-or-model"
            disabled={!settings.apiKeyPresent || settings.modelsLoading}
            onChange={(e) => void selectModel(e.currentTarget.value)}
          >
            <For each={settings.models}>
              {(m) => (
                <option value={m.id} selected={m.id === settings.selectedModel}>
                  {m.name}
                </option>
              )}
            </For>
          </select>
          <button
            type="button"
            disabled={!settings.apiKeyPresent || settings.modelsLoading}
            onClick={() => void loadModels()}
          >
            Refresh
          </button>
        </div>
        <p class="dz-settings__hint">Pick a vision-capable model; cost varies per model.</p>
      </section>
    </div>
  );
}
