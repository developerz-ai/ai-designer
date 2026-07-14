import { For, Show } from 'solid-js';
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
      <ol class="dz-tasktimeline" aria-label="Ship task status">
        <For each={tasks} fallback={null}>
          {(task) => {
            const s = () => stage(task.status);
            return (
              <li class="dz-tasktimeline__item" data-task-id={rowKey(task)}>
                <span class={`dz-tasktimeline__stage is-${s().tone}`}>
                  <Icon name={s().icon} size="sm" spin={s().spin} />
                </span>
                <div class="dz-tasktimeline__meta">
                  <strong class="dz-tasktimeline__title">{task.title}</strong>
                  <small class="dz-tasktimeline__status">
                    {statusLabel(task.status)}
                    <Show when={task.total > 1}>
                      {' '}
                      · task {task.index + 1}/{task.total}
                    </Show>
                  </small>
                  <Show when={task.error}>
                    <small class="dz-tasktimeline__error">{task.error}</small>
                  </Show>
                </div>
                <Show when={task.prUrl}>
                  {(url) => (
                    <a
                      class="dz-tasktimeline__pr"
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="externalLink" size="sm" /> PR
                    </a>
                  )}
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
    </Show>
  );
}
