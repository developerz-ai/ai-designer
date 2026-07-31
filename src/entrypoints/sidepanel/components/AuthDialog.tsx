import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { McpServer } from '@/shared/messages';
import { Icon } from './Icon';
import './AuthDialog.scss';
import { authError, authPending, startOAuth, submitApiKey } from '../stores/mcp';

export interface AuthDialogProps {
  server: McpServer;
  onClose: () => void;
}

type Mode = 'apikey' | 'oauth';

// Render + dispatch only — no fetch, no chrome.identity, no key-store. Both credential
// paths (API key / OAuth PKCE) call straight through to ../stores/mcp, which owns the
// mcp-auth-start round-trip to the service worker (CLAUDE.md "SolidJS + SRP"; secrets
// cross panel->SW only, see CLAUDE.md "MV3 three worlds").
export function AuthDialog(props: AuthDialogProps) {
  const [mode, setMode] = createSignal<Mode>(
    props.server.authKind === 'oauth' ? 'oauth' : 'apikey',
  );
  let dialogRef!: HTMLDivElement;
  let keyInput!: HTMLInputElement;
  let authEndpoint!: HTMLInputElement;
  let tokenEndpoint!: HTMLInputElement;
  let clientId!: HTMLInputElement;
  let scope!: HTMLInputElement;

  // The modal contract `aria-modal="true"` promises, implemented the way `Onboarding.tsx` does:
  // move focus in, keep Tab inside, Escape closes, and focus returns where it came from. This is
  // the one screen in the panel where a CREDENTIAL is typed — with focus left on the "Authorize"
  // button behind it, Tab walked out into content ARIA has declared inert, where a screen reader
  // announces nothing (#165 S7).
  let invoker: HTMLElement | null = null;
  onMount(() => {
    invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusable()[0]?.focus();
  });
  // Restoring focus to the element that opened the dialog belongs to the dialog, not its caller:
  // captured above at mount, so no parent has to hold a ref across the close.
  onCleanup(() => invoker?.focus());

  /** The dialog's tab ring, in DOM order. Re-queried per keystroke — the form swaps entirely
   *  between the API-key and OAuth tabs. */
  function focusable(): HTMLElement[] {
    return [
      ...dialogRef.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href]',
      ),
    ];
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const ring = focusable();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const pending = () => authPending() === props.server.id;

  async function handleApiKey(e: Event): Promise<void> {
    e.preventDefault();
    const key = keyInput.value.trim();
    if (!key) return;
    const ok = await submitApiKey(props.server.id, key);
    if (ok) props.onClose();
  }

  async function handleOAuth(e: Event): Promise<void> {
    e.preventDefault();
    const ok = await startOAuth(props.server.id, {
      authorizationEndpoint: authEndpoint.value.trim(),
      tokenEndpoint: tokenEndpoint.value.trim(),
      clientId: clientId.value.trim(),
      scope: scope.value.trim() || undefined,
    });
    if (ok) props.onClose();
  }

  return (
    <div class="dz-authdialog__backdrop">
      <button
        type="button"
        class="dz-authdialog__backdrop-dismiss"
        aria-label={i18n.t('auth.backdrop.ariaLabel')}
        onClick={props.onClose}
      />
      <div
        ref={dialogRef}
        class="dz-authdialog"
        role="dialog"
        aria-modal="true"
        aria-label={i18n.t('auth.title', { label: props.server.label })}
        onKeyDown={onKeyDown}
      >
        <header class="dz-authdialog__header">
          <strong>{i18n.t('auth.title', { label: props.server.label })}</strong>
          <button
            type="button"
            class="dz-authdialog__close"
            onClick={props.onClose}
            aria-label={i18n.t('auth.close.ariaLabel')}
          >
            <Icon name="close" size="sm" />
          </button>
        </header>

        <div class="dz-authdialog__tabs">
          <button
            type="button"
            classList={{ 'is-active': mode() === 'apikey' }}
            onClick={() => setMode('apikey')}
          >
            {i18n.t('auth.tab.apikey')}
          </button>
          <button
            type="button"
            classList={{ 'is-active': mode() === 'oauth' }}
            onClick={() => setMode('oauth')}
          >
            {i18n.t('auth.tab.oauth')}
          </button>
        </div>

        <Show when={mode() === 'apikey'}>
          <form class="dz-authdialog__form" onSubmit={handleApiKey}>
            <label class="dz-authdialog__label" for="dz-auth-key">
              {i18n.t('auth.apikey.label')}
            </label>
            <input
              id="dz-auth-key"
              ref={keyInput}
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder={i18n.t('auth.apikey.placeholder')}
            />
            <button type="submit" class="dz-authdialog__submit" disabled={pending()}>
              {pending() ? i18n.t('auth.apikey.saving') : i18n.t('auth.apikey.save')}
            </button>
          </form>
        </Show>

        <Show when={mode() === 'oauth'}>
          <form class="dz-authdialog__form" onSubmit={handleOAuth}>
            <label class="dz-authdialog__label" for="dz-auth-authz">
              {i18n.t('auth.oauth.authEndpoint.label')}
            </label>
            <input
              id="dz-auth-authz"
              ref={authEndpoint}
              type="url"
              placeholder={i18n.t('auth.oauth.authEndpoint.placeholder')}
            />
            <label class="dz-authdialog__label" for="dz-auth-token">
              {i18n.t('auth.oauth.tokenEndpoint.label')}
            </label>
            <input
              id="dz-auth-token"
              ref={tokenEndpoint}
              type="url"
              placeholder={i18n.t('auth.oauth.tokenEndpoint.placeholder')}
            />
            <label class="dz-authdialog__label" for="dz-auth-client">
              {i18n.t('auth.oauth.clientId.label')}
            </label>
            <input
              id="dz-auth-client"
              ref={clientId}
              type="text"
              placeholder={i18n.t('auth.oauth.clientId.placeholder')}
            />
            <label class="dz-authdialog__label" for="dz-auth-scope">
              {i18n.t('auth.oauth.scope.label')}
            </label>
            <input
              id="dz-auth-scope"
              ref={scope}
              type="text"
              placeholder={i18n.t('auth.oauth.scope.placeholder')}
            />
            <button type="submit" class="dz-authdialog__submit" disabled={pending()}>
              {pending() ? (
                <>
                  <Icon name="spinner" size="sm" spin /> {i18n.t('auth.oauth.authorizing')}
                </>
              ) : (
                <>
                  <Icon name="externalLink" size="sm" /> {i18n.t('auth.oauth.authorize')}
                </>
              )}
            </button>
          </form>
        </Show>

        <Show when={authError()}>
          <p class="dz-authdialog__error">
            <Icon name="warning" size="sm" /> {authError()}
          </p>
        </Show>
      </div>
    </div>
  );
}
