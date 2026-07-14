// Complex-site tools for the agent loop (slice 15, expose-to-agent) — the pieces that make an SPA /
// shadow-DOM / widget-heavy / charted page tractable: read the page's detected stack (`pageFacts`),
// read a chart's real data or a vision-fallback plan (`readChart`), hover a chart host for its HTML
// tooltip (`chartTooltip`), and drive an ARIA widget through its recipe (`widgetAct`) instead of a
// blind click/type sequence. Derived 1:1 from the Zod input consts in `src/shared/messages.ts` (the
// tool NAME carries the `type` discriminant; `inputSchema` is that const minus `type`), the same
// zero-drift contract the other tool modules hold.
//
// SW-ONLY by usage, chrome-free by construction: every call round-trips through the same
// `ControlDispatch` transport `createInteractTools` uses (`content.ts` parses `ControlTool`), so
// wiring these in the loop/background is a one-line addition alongside `interact`.

import { tool } from 'ai';
import {
  ChartTooltipInput,
  type ControlTool,
  PageFactsInput,
  ReadChartInput,
  ToolResult,
  WidgetActInput,
} from '@/shared/messages';

/** Round-trips one complex-site `ControlTool` to the target frame's content script. Reuses the
 *  same transport shape as `ControlDispatch` (`src/agent/tools/interact.ts`) — in practice the
 *  loop wires both to the same `content` dispatch. */
export type ComplexSiteDispatch = (msg: ControlTool, signal?: AbortSignal) => Promise<ToolResult>;

/**
 * Build the complex-site `ToolSet` for one turn. Each `execute` reattaches the tool name's `type`
 * discriminant, forwards the model's args (incl. the `Target`), threads the abort signal, and
 * returns the dispatch's `ToolResult` verbatim.
 */
export function createComplexSiteTools(dispatch: ComplexSiteDispatch) {
  return {
    pageFacts: tool({
      description:
        "Detect the page's runtime stack — UI frameworks, chart/dataviz libs, notable libraries — " +
        'and whether it is a client-rendered SPA. ToolResult.data = PageFacts { frameworks, ' +
        'chartLibs, libraries, spa, url }. Call this FIRST on an unfamiliar page: `spa: true` means ' +
        'await hydration (`waitFor` with `hydrated`/`quiescent`) before reading or acting, and a ' +
        'non-empty `chartLibs` means try `readChart` before falling back to a screenshot. Cached per ' +
        'URL — cheap to call again after a route change.',
      inputSchema: PageFactsInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'pageFacts', ...input }, abortSignal),
    }),
    readChart: tool({
      description:
        "Read a chart's real data. Tries a MAIN-world data probe against the page's own chart-lib " +
        'instance first (Chart.js/ECharts/Highcharts/D3/Recharts — exact series, no pixel-reading), ' +
        'then a DOM-only pass. ToolResult.data = ChartRead: `source: "data"` with `charts` (numeric ' +
        'series, labels, kind) when it worked; `source: "vision"` with `targets` (host selectors) ' +
        'when nothing was reachable (canvas/WebGL/closed lib) — screenshot + `describe` those instead. ' +
        'Omit `selector` to read every chart on the page; scope it to re-probe one. Probe chart data ' +
        'before spending a screenshot on a chart.',
      inputSchema: ReadChartInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'readChart', ...input }, abortSignal),
    }),
    chartTooltip: tool({
      description:
        'Hover the chart host matching `selector` (a `readChart` vision `targets` entry) and read ' +
        'any HTML tooltip that appears — a way to read values off a chart with no reachable lib data ' +
        'without pixel-reading. ToolResult.data = { text } | null (no tooltip rendered).',
      inputSchema: ChartTooltipInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) =>
        dispatch({ type: 'chartTooltip', ...input }, abortSignal),
    }),
    widgetAct: tool({
      description:
        'Drive a complex ARIA widget through an anchored recipe instead of a blind click/type ' +
        'sequence — a datetime picker, combobox, slider, toggle/switch, modal, tab set, carousel, or ' +
        'drag-drop. Content resolves the widget by its ARIA role contract (survives restyling) and ' +
        'fires a realistic event sequence. `recipe.type` picks the shape: `datetime` (selector + ISO ' +
        '`date`), `combobox` (selector + option `value`), `slider` (selector + numeric `value`), ' +
        '`toggle` (selector + `on`), `modal` (selector + `action`: open/confirm/dismiss), `tabs` ' +
        '(selector + tab `value`), `carousel` (selector + `direction` + optional `times`), `dragDrop` ' +
        '(`selector` + `to`). ToolResult.data = WidgetActed { widget, reached, steps, state } — read ' +
        '`reached`/`steps` to confirm it actually landed before assuming the interaction worked.',
      inputSchema: WidgetActInput.omit({ type: true }),
      outputSchema: ToolResult,
      execute: (input, { abortSignal }) => dispatch({ type: 'widgetAct', ...input }, abortSignal),
    }),
  };
}
