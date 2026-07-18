import { createMemo, createSignal, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import { send as sendMessage, stopTurn, streaming } from '../../stores/chat';
import { pickerActive, selector, startPicker } from '../../stores/focus';
import { settings, switchModel } from '../../stores/settings';
import { Icon } from '../Icon';
import './Composer.scss';
import { ContextChip } from './ContextChip';

// The message composer: free-text input + send/stop, an inline model quick-switch, and an
// "attach element" trigger for the picker (Cursor-style pin — `ContextChip` renders what gets
// pinned, from `stores/focus.ts`). Enter sends, Shift+Enter inserts a newline. Draft text is
// local UI state; everything else (send/stop, model persistence, picker start) dispatches
// through its store — no business logic here (CLAUDE.md "SolidJS + SRP").
/** Enter submits, Shift+Enter (or any other modifier combo) inserts a newline instead. Pure so
 *  it's unit-testable without a real KeyboardEvent/DOM. */
export function isSubmitKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey;
}

export function Composer() {
  const [draft, setDraft] = createSignal('');
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);

  const canSend = createMemo(() => draft().trim().length > 0 && !streaming());
  const attachActive = createMemo(() => pickerActive() || selector() !== null);
  const currentModelLabel = createMemo(() => settings.model ?? i18n.t('composer.modelFallback'));

  function submit(): void {
    const text = draft();
    if (!text.trim() || streaming()) return;
    setDraft('');
    void sendMessage(text);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isSubmitKey(e)) {
      e.preventDefault();
      submit();
    }
  }

  function pickModel(model: string): void {
    setModelMenuOpen(false);
    void switchModel(model);
  }

  return (
    <div class="dz-composer">
      <ContextChip />

      <textarea
        class="dz-composer__input"
        placeholder={i18n.t('composer.placeholder')}
        rows={1}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        disabled={streaming()}
      />

      <div class="dz-composer__toolbar">
        <button
          type="button"
          class="dz-composer__attach"
          classList={{ 'is-active': attachActive() }}
          aria-pressed={attachActive()}
          title={i18n.t('composer.attach.title')}
          onClick={() => void startPicker()}
        >
          <Icon name="picker" size="sm" />
        </button>

        <div class="dz-composer__model">
          <button
            type="button"
            class="dz-composer__model-trigger"
            disabled={settings.models.length === 0}
            aria-expanded={modelMenuOpen()}
            onClick={() => setModelMenuOpen((v) => !v)}
          >
            <span class="dz-composer__model-label">{currentModelLabel()}</span>
            <Icon name="chevronDown" size="sm" />
          </button>
          <Show when={modelMenuOpen()}>
            <ul class="dz-composer__model-menu">
              <For each={settings.models}>
                {(m) => (
                  <li>
                    <button type="button" onClick={() => pickModel(m.id)}>
                      {m.name}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        <div class="dz-composer__spacer" />

        <Show
          when={streaming()}
          fallback={
            <button
              type="button"
              class="dz-composer__send"
              aria-label={i18n.t('composer.send.ariaLabel')}
              disabled={!canSend()}
              onClick={submit}
            >
              <Icon name="send" size="sm" />
            </button>
          }
        >
          <button type="button" class="dz-composer__stop" onClick={() => void stopTurn()}>
            {i18n.t('composer.stop')}
          </button>
        </Show>
      </div>
    </div>
  );
}
