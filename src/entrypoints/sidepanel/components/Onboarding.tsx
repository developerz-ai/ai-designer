import { createMemo, For, onMount, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { ReadinessState } from '@/shared/messages';
import { DOCS_URL, PRIVACY_URL } from '../../../shared/links';
import { dismissOnboarding, hideOnboarding } from '../stores/onboarding';
import { initReadinessStore, state as readinessState } from '../stores/readiness';
import { Icon } from './Icon';
import type { IconName } from './icon-registry';
import type { DeepLinkTab } from './ReadinessDropdown';
import './Onboarding.scss';

export type OnboardingStepId = 'provider' | 'mcp' | 'start';

export interface OnboardingStepState {
  id: OnboardingStepId;
  done: boolean;
  current: boolean;
}

// Always exactly three steps, in order — a fixed tuple so indexing/destructuring is defined
// under `noUncheckedIndexedAccess` (no `?`/`!` at every call site).
export type OnboardingStepTriple = [OnboardingStepState, OnboardingStepState, OnboardingStepState];

/** Derive the three first-run steps from live readiness (thin RPC+stream reflection of the SW's
 *  `computeReadiness`). Pure so the done/current logic is unit-testable without mounting Solid —
 *  mirrors ReadinessDropdown's `sessionButton` / stores/readiness.ts's `reduceReadiness`.
 *
 *  "provider" is done once both a key and a model are configured (the pair that gates Start).
 *  "mcp" is optional — done when ≥1 backend is connected, but it never becomes the *current*
 *  (blocking) step. "start" is the terminal action, never auto-"done"; it's current once the
 *  required provider config is in place. */
export function onboardingSteps(state: ReadinessState | null): OnboardingStepTriple {
  const providerDone = state?.provider === 'ok' && state?.model === 'ok';
  const mcpDone = (state?.mcp.connected ?? 0) > 0;
  const current: OnboardingStepId = providerDone ? 'start' : 'provider';
  return [
    { id: 'provider', done: providerDone, current: current === 'provider' },
    { id: 'mcp', done: mcpDone, current: false },
    { id: 'start', done: false, current: current === 'start' },
  ];
}

// Per-step copy, resolved once at module load (single fixed `en` locale — same pattern as
// stores/settings.ts's PRESETS). Keeping the keys literal keeps them typed against `#i18n`.
const STEP_COPY: Record<OnboardingStepId, { label: string; desc: string; cta: string }> = {
  provider: {
    label: i18n.t('onboarding.step.provider.label'),
    desc: i18n.t('onboarding.step.provider.desc'),
    cta: i18n.t('onboarding.step.provider.cta'),
  },
  mcp: {
    label: i18n.t('onboarding.step.mcp.label'),
    desc: i18n.t('onboarding.step.mcp.desc'),
    cta: i18n.t('onboarding.step.mcp.cta'),
  },
  start: {
    label: i18n.t('onboarding.step.start.label'),
    desc: i18n.t('onboarding.step.start.desc'),
    cta: i18n.t('onboarding.step.start.cta'),
  },
};

// The tab a step's "Fix" CTA deep-links to; "start" has none (it just closes the guide). Typed
// over every step id (null for "start") so the CTA reads it without a cast — `<Show>` doesn't
// narrow `step.id`, so the null branch is unreachable in render but keeps the lookup total.
const STEP_TAB: Record<OnboardingStepId, DeepLinkTab | null> = {
  provider: 'settings',
  mcp: 'mcp',
  start: null,
};
const STEP_ICON: Record<OnboardingStepId, IconName> = {
  provider: 'settings',
  mcp: 'mcp',
  start: 'ship',
};

export interface OnboardingProps {
  onNavigate: (tab: DeepLinkTab) => void;
}

// First-run guide (slice 24). A dismissible overlay listing three steps to a first live edit,
// each reflecting live readiness. Render + dispatch only (CLAUDE.md "no business logic in
// components"): step state is `onboardingSteps` above, visibility + persistence live in
// stores/onboarding.ts. A step's CTA hides the guide (without persisting) and switches to the
// tab that fixes it, so re-opening later shows the completed step checked off; Skip / "Get
// started" persist the dismissal.
export function Onboarding(props: OnboardingProps) {
  onMount(() => initReadinessStore());
  const steps = createMemo(() => onboardingSteps(readinessState()));

  function goTo(tab: DeepLinkTab): void {
    hideOnboarding();
    props.onNavigate(tab);
  }

  return (
    <div
      class="dz-onboarding"
      data-testid="first-run-onboarding"
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t('onboarding.ariaLabel')}
    >
      <div class="dz-onboarding__card">
        <button type="button" class="dz-onboarding__skip" onClick={() => void dismissOnboarding()}>
          {i18n.t('onboarding.skip')} <Icon name="close" size="sm" />
        </button>

        <div class="dz-onboarding__head">
          <span class="dz-onboarding__badge">
            <Icon name="agent" size="md" />
          </span>
          <h1 class="dz-onboarding__title">{i18n.t('onboarding.title')}</h1>
          <p class="dz-onboarding__subtitle">{i18n.t('onboarding.subtitle')}</p>
        </div>

        <ol class="dz-onboarding__steps">
          <For each={steps()}>
            {(step, i) => (
              <li
                class="dz-onboarding__step"
                classList={{ 'is-done': step.done, 'is-current': step.current }}
              >
                <span class="dz-onboarding__stepnum" aria-hidden="true">
                  <Show when={step.done} fallback={i() + 1}>
                    <Icon name="check" size="sm" />
                  </Show>
                </span>
                <div class="dz-onboarding__stepbody">
                  <span class="dz-onboarding__steplabel">
                    {STEP_COPY[step.id].label}
                    <Show when={step.id === 'mcp'}>
                      <small class="dz-onboarding__optional">{i18n.t('onboarding.optional')}</small>
                    </Show>
                  </span>
                  <p class="dz-onboarding__stepdesc">{STEP_COPY[step.id].desc}</p>
                </div>
                <Show
                  when={step.id !== 'start'}
                  fallback={
                    <button
                      type="button"
                      class="dz-onboarding__cta is-primary"
                      onClick={() => void dismissOnboarding()}
                    >
                      {STEP_COPY.start.cta} <Icon name={STEP_ICON.start} size="sm" />
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="dz-onboarding__cta"
                    onClick={() => {
                      const tab = STEP_TAB[step.id];
                      if (tab) goTo(tab);
                    }}
                  >
                    {STEP_COPY[step.id].cta} <Icon name={STEP_ICON[step.id]} size="sm" />
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ol>

        <footer class="dz-onboarding__footer">
          <a class="dz-onboarding__link" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            <Icon name="report" size="sm" /> {i18n.t('onboarding.docsLink')}
          </a>
          <a
            class="dz-onboarding__link"
            href={PRIVACY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="site" size="sm" /> {i18n.t('onboarding.privacyLink')}
          </a>
        </footer>
      </div>
    </div>
  );
}
