import { For, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { TaskStatus } from '../stores/changeset';
import { tasks } from '../stores/changeset';
import { Icon } from './Icon';
import type { IconName } from './icon-registry';
import './TaskTimeline.scss';

// Render-only: one row per task on the Ship timeline, sourced straight from the thin
// `stores/changeset` reflection of the SW's `task-status` stream (CLAUDE.md "SolidJS + SRP" — no
// polling, no MCP/task logic here). A multi-task `ship({problems})` fan-out streams several
// `taskId`s independently, so the timeline is keyed by `taskId`, not by ship-call.

// The SW's `status` (`src/shared/messages.ts` `task-status`) is an open string
// (`queued → working → pr_open → ci_green/ci_red`, or `error`) — this maps the known stages to a
// glyph + tone; anything else (a backend-specific status word) still renders, just muted.
const STAGE: Record<string, { icon: IconName; tone: string; spin?: boolean }> = {
  queued: { icon: 'status', tone: 'muted' },
  working: { icon: 'spinner', tone: 'accent', spin: true },
  pr_open: { icon: 'externalLink', tone: 'accent' },
  ci_green: { icon: 'check', tone: 'success' },
  ci_red: { icon: 'warning', tone: 'danger' },
  error: { icon: 'warning', tone: 'danger' },
};

function stage(status: string): { icon: IconName; tone: string; spin?: boolean } {
  return STAGE[status] ?? { icon: 'status', tone: 'muted' };
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function rowKey(task: TaskStatus): string {
  return task.taskId;
}

export function TaskTimeline() {
  return (
    <Show when={tasks.length > 0}>
      {/* One card holding N rows, not N cards. A fan-out ships several tasks at once, and a
          stack of separate cards read as unrelated notices rather than as one run's progress. */}
      <div class="dz-tasktimeline">
        <p class="dz-tasktimeline__heading">{i18n.t('task.timeline.ariaLabel')}</p>
        <ol class="dz-tasktimeline__list" aria-label={i18n.t('task.timeline.ariaLabel')}>
          <For each={tasks} fallback={null}>
            {(task) => {
              const s = () => stage(task.status);
              return (
                <li class="dz-tasktimeline__item" data-task-id={rowKey(task)}>
                  {/* Title line: glyph · title · the backend's own status word, right-aligned
                      and mono so a column of them lines up down the card. */}
                  <div class="dz-tasktimeline__row">
                    <span class={`dz-tasktimeline__stage is-${s().tone}`}>
                      <Icon name={s().icon} size="sm" spin={s().spin} class="dz-icon--fixed" />
                    </span>
                    <span class="dz-tasktimeline__title">{task.title}</span>
                    <span class="dz-tasktimeline__status">{statusLabel(task.status)}</span>
                  </div>
                  {/* Second line, indented under the title: the fan-out counter and the PR link
                      only exist for some tasks, so the row renders only when one of them does. */}
                  <Show when={task.total > 1 || task.prUrl}>
                    <div class="dz-tasktimeline__meta">
                      <Show when={task.total > 1}>
                        <span class="dz-tasktimeline__counter">
                          {i18n.t('task.counter', {
                            index: String(task.index + 1),
                            total: String(task.total),
                          })}
                        </span>
                      </Show>
                      <Show when={task.prUrl}>
                        {(url) => (
                          <a
                            class="dz-tasktimeline__pr"
                            href={url()}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Icon name="externalLink" size="sm" class="dz-icon--fixed" />
                            {i18n.t('task.prLink')}
                          </a>
                        )}
                      </Show>
                    </div>
                  </Show>
                  <Show when={task.error}>
                    <p class="dz-tasktimeline__error">{task.error}</p>
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </div>
    </Show>
  );
}
