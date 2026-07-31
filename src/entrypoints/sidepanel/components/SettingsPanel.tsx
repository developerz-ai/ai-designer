import { For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import { openOnboarding } from '../stores/onboarding';
import { startSession } from '../stores/session';
import {
  clearProvider,
  hydrate,
  loadModels,
  PRESETS,
  type ProviderPreset,
  pickModel,
  type SaveStatus,
  saveProvider,
  selectPreset,
  setCustomBaseURL,
  settings,
} from '../stores/settings';
import { AboutSection } from './AboutSection';
import { ModelCombobox } from './ModelCombobox';
import './SettingsPanel.scss';

/** Wipe the key input only after a validated save. A host-permission denial or a rejected config
 *  leaves `saveStatus` at `invalid`/`saving`, so the typed key survives for a retry instead of
 *  forcing a re-type. Pure so the clear-on-success rule is unit-testable. */
export function clearKeyOnSave(saveStatus: SaveStatus): boolean {
  return saveStatus === 'valid';
}

// Render + dispatch only — no fetch, no crypto, no chrome.*. All logic lives in
// ../stores/settings (which talks to the service worker). The key input is never
// echoed back: it's a password field and the placeholder reflects presence, not
// the value (CLAUDE.md "MV3 three worlds" — the key never leaves the SW world).
export interface SettingsPanelProps {
  /** Take the user to the conversation. Wired to the post-save "Start designing" CTA below, which
   *  is the one thing missing from the install → configure → chat flow: with the form done, the
   *  next action lived in a different tab behind a header dropdown. Deliberately a CTA rather than
   *  an automatic tab switch — navigating away on save would rip the "saved and reachable" /
   *  "needs an API key" verdict off screen before it could be read. */
  onStart?: () => void;
}

export function SettingsPanel(props: SettingsPanelProps = {}) {
  let keyInput!: HTMLInputElement;
  onMount(() => {
    void hydrate();
  });

  // The model control is a combobox, not a `<select>` (see ModelCombobox.tsx): it shows exactly
  // what the store holds — including a pasted id that `/models` never listed — so the old
  // "displayed option 0 while `model` was null" divergence (#165 S2) can't recur; there is no
  // browser-side fallback selection to disagree with.

  function statusText(): string {
    switch (settings.saveStatus) {
      case 'valid':
        return i18n.t('settings.status.valid');
      case 'invalid':
        return settings.error ?? i18n.t('settings.status.invalidFallback');
      case 'saving':
        return i18n.t('settings.status.saving');
      default:
        return settings.hasKey
          ? i18n.t('settings.status.keySaved')
          : i18n.t('settings.status.noKey');
    }
  }

  return (
    <div class="dz-settings">
      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-preset">
          {i18n.t('settings.provider.label')}
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
            placeholder={i18n.t('settings.provider.customUrlPlaceholder')}
            value={settings.baseURL}
            onInput={(e) => setCustomBaseURL(e.currentTarget.value)}
          />
        </Show>
      </section>

      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-key">
          {i18n.t('settings.apiKey.label')}
        </label>
        <div class="dz-settings__keyrow">
          <input
            id="dz-key"
            ref={keyInput}
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder={
              settings.hasKey
                ? i18n.t('settings.apiKey.placeholderSaved')
                : i18n.t('settings.apiKey.placeholderEmpty')
            }
          />
          <Show when={settings.hasKey}>
            <button type="button" class="dz-settings__ghost" onClick={() => void clearProvider()}>
              {i18n.t('settings.apiKey.clear')}
            </button>
          </Show>
        </div>
      </section>

      <section class="dz-settings__section">
        <label class="dz-settings__label" for="dz-model">
          {i18n.t('settings.model.label')}
        </label>
        <div class="dz-settings__modelrow">
          <ModelCombobox
            id="dz-model"
            value={settings.model ?? ''}
            options={settings.models}
            loading={settings.modelsLoading}
            onCommit={pickModel}
          />
          <button
            type="button"
            disabled={settings.modelsLoading}
            onClick={() => void loadModels(keyInput.value)}
          >
            {i18n.t('settings.model.refresh')}
          </button>
        </div>
        <p class="dz-settings__hint">{i18n.t('settings.model.hint')}</p>
      </section>

      <section class="dz-settings__section">
        <button
          type="button"
          class="dz-settings__save"
          disabled={settings.saveStatus === 'saving' || !settings.model}
          onClick={() => {
            void saveProvider(keyInput.value, settings.model ?? '').then(() => {
              if (clearKeyOnSave(settings.saveStatus)) keyInput.value = '';
            });
          }}
        >
          {i18n.t('settings.save')}
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
        {/* The next step, at the moment it becomes available. */}
        <Show when={settings.saveStatus === 'valid'}>
          <button
            type="button"
            class="dz-settings__start"
            onClick={() => {
              void startSession();
              props.onStart?.();
            }}
          >
            {i18n.t('settings.startDesigning')}
          </button>
        </Show>
      </section>

      <section class="dz-settings__section">
        <button type="button" class="dz-settings__ghost" onClick={() => openOnboarding()}>
          {i18n.t('settings.setupGuide.button')}
        </button>
      </section>

      <AboutSection />
    </div>
  );
}
