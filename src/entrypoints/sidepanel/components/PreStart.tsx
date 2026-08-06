import { createMemo, Show } from 'solid-js';
import { i18n } from '#i18n';
import { state as readinessState } from '../stores/readiness';
import { startSession } from '../stores/session';
import { Icon } from './Icon';
import './PreStart.scss';

// The pre-Start Chat surface. It used to be one dead sentence ("Configure a provider above, then
// hit Start to begin chatting") pointing at a Start button that lives in the header — so the first
// screen after install told you what to do without letting you do it. Now it carries the action
// itself, and which action depends on where setup actually is: not configured → open Settings;
// configured → Start, right here.
//
// Render + dispatch only (CLAUDE.md "SolidJS + SRP"): readiness is a store read, Start dispatches
// through the session store, and the Settings jump is the shell's business (a prop).

export interface PreStartProps {
  onOpenSettings: () => void;
}

export function PreStart(props: PreStartProps) {
  const ready = createMemo(() => readinessState()?.ready ?? false);

  return (
    <div class="dz-prestart">
      {/* A wrapper span, not the Icon element itself: `.dz-icon` sets its own sizing at the
          same specificity, so an override on that element wins or loses on stylesheet order. */}
      <span class="dz-prestart__icon">
        <Icon name="agent" size="md" class="dz-icon--fixed" />
      </span>
      <h2 class="dz-prestart__title">
        {ready() ? i18n.t('prestart.ready.title') : i18n.t('prestart.setup.title')}
      </h2>
      {/* The copy is one text node in one element on purpose: test/e2e/readiness.spec.ts matches
          it verbatim with getByText. */}
      <p class="dz-prestart__text">
        {ready() ? i18n.t('prestart.ready.body') : i18n.t('prestart.setup.body')}
      </p>
      <Show
        when={ready()}
        fallback={
          <button type="button" class="dz-prestart__cta" onClick={() => props.onOpenSettings()}>
            <Icon name="sliders" size="sm" class="dz-icon--fixed" />
            {i18n.t('prestart.setup.cta')}
          </button>
        }
      >
        <button
          type="button"
          class="dz-prestart__cta"
          onClick={() => {
            void startSession();
          }}
        >
          <Icon name="play" size="sm" class="dz-icon--fixed" />
          {i18n.t('prestart.ready.cta')}
        </button>
      </Show>
    </div>
  );
}
