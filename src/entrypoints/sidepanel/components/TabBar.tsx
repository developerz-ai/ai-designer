import { For } from 'solid-js';
import { i18n } from '#i18n';
import { Icon } from './Icon';
import type { IconName } from './icon-registry';
import './TabBar.scss';

// The panel's route-like surfaces. Declared here rather than in App.tsx and imported back
// by it — the same shape `DeepLinkTab` uses in ReadinessDropdown.tsx, and for the same
// reason: App renders this component, so owning the type there would close a cycle.
export type Tab = 'chat' | 'diff' | 'mcp' | 'history' | 'settings';

export interface TabBarProps {
  /** Currently rendered surface — drives `is-active` and `aria-current`. */
  active: Tab;
  /** Fired with the tab the user picked. The caller owns the state. */
  onSelect: (tab: Tab) => void;
}

// MCP server management is live (slice 02) — connect implement backends the agent
// ships changesets to. See docs/idea/mcp.md.
const SHOW_MCP = true;

interface TabSpec {
  id: Tab;
  /** Accessible name. Rendered as visible text unless `icon` is set, in which case it
   *  becomes the `aria-label` — these five strings are matched by name across the e2e
   *  suite, so they are byte-identical to what the hand-written buttons carried. */
  name: string;
  icon?: IconName;
}

// Built per render, not at module scope, so the localized names resolve through the same
// `i18n.t` call path as every other string in the panel. Static data, no logic.
function tabSpecs(): TabSpec[] {
  return [
    { id: 'chat', name: i18n.t('app.tab.chat') },
    { id: 'diff', name: i18n.t('app.tab.diff.ariaLabel'), icon: 'diff' },
    ...(SHOW_MCP ? [{ id: 'mcp' as const, name: i18n.t('app.tab.mcp') }] : []),
    { id: 'history', name: i18n.t('app.tab.history.ariaLabel'), icon: 'history' },
    { id: 'settings', name: i18n.t('app.tab.settings') },
  ];
}

// Sole responsibility: render the tab strip and report the pick (CLAUDE.md "SolidJS + SRP"
// — render + dispatch only). Deliberately NOT role="tablist"/role="tab": these are
// route-like panels, not tab panels, and the whole e2e suite locates them as buttons.
// `aria-current="page"` carries the selected state to AT, which the previous
// visual-only `is-active` class did not.
export function TabBar(props: TabBarProps) {
  return (
    <nav class="dz-tabbar">
      <For each={tabSpecs()}>
        {(spec) => (
          <button
            type="button"
            class="dz-tabbar__tab"
            classList={{ 'is-active': props.active === spec.id }}
            aria-current={props.active === spec.id ? 'page' : undefined}
            aria-label={spec.icon ? spec.name : undefined}
            onClick={() => props.onSelect(spec.id)}
          >
            {spec.icon ? <Icon name={spec.icon} size="sm" class="dz-icon--fixed" /> : spec.name}
          </button>
        )}
      </For>
    </nav>
  );
}
