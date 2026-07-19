import { Show } from 'solid-js';
import type { TurnUsage } from '@/shared/messages';
import './UsageMeter.scss';

// Session usage meter (#25) — a small, unobtrusive readout of this design session's cumulative
// model spend (steps + tokens), the "cost shown via usage accounting" guardrail. Tokens are the
// unit on purpose: a BYOK endpoint (any openai-compatible /v1) has no universal price, so we
// account spend and never fabricate a dollar figure. Presentational — the container (ChatPanel)
// feeds it the chat store's `usage`; hidden until the first turn has spent anything.
export function UsageMeter(props: { usage: TurnUsage }) {
  return (
    <Show when={props.usage.steps > 0 || props.usage.tokens > 0}>
      <p class="dz-usage" title="Cumulative model usage this design session">
        <span class="dz-usage__label">Usage</span>
        <span class="dz-usage__spend">
          {props.usage.steps} {props.usage.steps === 1 ? 'step' : 'steps'} · ~
          {formatTokens(props.usage.tokens)} tokens
        </span>
      </p>
    </Show>
  );
}

/** Compact token count: `12.4k` past a thousand, else the raw integer. Exported for unit coverage —
 *  the repo tests a component's pure building blocks, not its JSX (see tool-chip.test.ts). */
export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
