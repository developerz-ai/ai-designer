import { createSignal, Show } from 'solid-js';
import { i18n } from '#i18n';
import { Icon } from '../Icon';
import type { IconName } from '../icon-registry';
import './ToolChip.scss';

// One tool call as a dev-legible, expandable chip — name + kind badge, selector on expand
// (CLAUDE.md "SolidJS + SRP": presentational only, no business logic). The chat stream (11) only
// carries `tool`/`selector`/`kind` per call today (`stores/chat.ts` `ToolCallEntry`) — a single
// event fired once the tool has run, not a call/result pair — so `status` defaults to `'done'`;
// callers pass `'running'`/`'error'` once a richer per-call lifecycle lands. `summary` is an
// optional caller-supplied one-liner for the collapsed row (e.g. "extractIdentity -> 4 colors").
export type ToolChipStatus = 'running' | 'done' | 'error';

export interface ToolChipProps {
  tool: string;
  selector?: string;
  kind?: 'read' | 'act' | 'info';
  status?: ToolChipStatus;
  summary?: string;
}

const STATUS_ICON: Record<ToolChipStatus, IconName> = {
  running: 'spinner',
  done: 'check',
  error: 'warning',
};

const KIND_LABEL: Record<'read' | 'act' | 'info', string> = {
  read: i18n.t('toolChip.kind.read'),
  act: i18n.t('toolChip.kind.act'),
  info: i18n.t('toolChip.kind.info'),
};

/** Defaults an unset status to `'done'` — the chat store doesn't carry a per-call status yet
 *  (see the module comment above), so most callers pass nothing. Pure + exported so the
 *  rendering contract is unit-testable without mounting Solid. */
export function toolChipStatus(status?: ToolChipStatus): ToolChipStatus {
  return status ?? 'done';
}

/** The icon glyph for a given status — the chip's leading indicator. */
export function toolChipStatusIcon(status: ToolChipStatus): IconName {
  return STATUS_ICON[status];
}

/** The badge text for a given kind, or `undefined` when the call carries none. */
export function toolChipKindLabel(kind?: 'read' | 'act' | 'info'): string | undefined {
  return kind ? KIND_LABEL[kind] : undefined;
}

export function ToolChip(props: ToolChipProps) {
  const [expanded, setExpanded] = createSignal(false);
  const status = () => toolChipStatus(props.status);
  const expandable = () => Boolean(props.selector);

  return (
    <div
      class="dz-tool-chip"
      classList={{
        [`dz-tool-chip--${status()}`]: true,
        [`dz-tool-chip--${props.kind ?? 'info'}`]: true,
      }}
    >
      <button
        type="button"
        class="dz-tool-chip__row"
        disabled={!expandable()}
        aria-expanded={expanded()}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon
          name={toolChipStatusIcon(status())}
          size="sm"
          spin={status() === 'running'}
          class="dz-tool-chip__status"
        />
        <code class="dz-tool-chip__name">{props.tool}</code>
        <Show when={props.kind}>
          {(kind) => <span class="dz-tool-chip__kind">{toolChipKindLabel(kind())}</span>}
        </Show>
        <Show when={props.summary}>
          {(summary) => <span class="dz-tool-chip__summary">{summary()}</span>}
        </Show>
        <Show when={expandable()}>
          <Icon
            name="chevronDown"
            size="sm"
            class={`dz-tool-chip__chevron${expanded() ? ' is-open' : ''}`}
          />
        </Show>
      </button>
      <Show when={expanded() && props.selector}>
        {(selector) => <code class="dz-tool-chip__detail">{selector()}</code>}
      </Show>
    </div>
  );
}
