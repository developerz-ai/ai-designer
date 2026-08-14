import { describe, expect, it, vi } from 'vitest';
import { createDomTools, type DomDispatch } from '@/agent/tools/dom';
import type { DomTool, ToolResult } from '@/shared/messages';

// Multi-target `getStyles` unit — the fix for the read storm that ate a whole turn's budget.
//
// The shipped failure (HN, 2026-08-14): "make the page more modern" spent its entire 200k token
// ceiling on 21 reads across 3 steps and made zero edits. Eleven were `getStyles`, one element per
// call, each returning all 22 design properties — because `getStyles` took exactly ONE `selector`
// and there was no multi-target read anywhere in the system. `batch` is mutations only, so the
// model was not ignoring a batching path: it was following "batch independent calls in one step"
// the only way the API allowed, with a wide fan-out of single-target calls.
//
// Both halves are fixed in the TOOL layer with no bus change: `selectors[]` fans out to N existing
// single-target bus messages, and `props[]` projects the result SW-side (`src/dom/read.ts` has
// always accepted a `props` argument; `GetStylesInput` never exposed it).

const ALL_PROPS = {
  color: 'rgb(0, 0, 0)',
  'background-color': 'rgb(255, 255, 255)',
  'font-family': 'Verdana',
  'font-size': '13px',
  padding: '8px',
  margin: '0px',
};

/** A dispatch that answers every `getStyles` with the full property set, and records the messages
 *  it was handed so the fan-out can be asserted. */
function fakeDispatch(overrides: Record<string, ToolResult> = {}) {
  const seen: DomTool[] = [];
  const dispatch: DomDispatch = vi.fn(async (msg: DomTool) => {
    seen.push(msg);
    const selector = 'selector' in msg ? String(msg.selector) : '';
    return (
      overrides[selector] ?? {
        type: 'tool-result' as const,
        ok: true,
        data: { styles: { ...ALL_PROPS } },
      }
    );
  });
  return { dispatch, seen };
}

const styles = (result: ToolResult): Record<string, Record<string, string>> =>
  (result.data as { styles: Record<string, Record<string, string>> }).styles;

describe('getStyles: many elements in one call', () => {
  it('fans one call out to one bus message per selector', async () => {
    const { dispatch, seen } = fakeDispatch();
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      { selectors: ['#a', '.b', 'main > p'] },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;

    expect(seen).toHaveLength(3);
    expect(seen.every((m) => m.type === 'getStyles')).toBe(true);
    expect(seen.map((m) => ('selector' in m ? m.selector : ''))).toEqual(['#a', '.b', 'main > p']);
    // Keyed by the selector the model passed, so it correlates without counting positions.
    expect(Object.keys(styles(result))).toEqual(['#a', '.b', 'main > p']);
  });

  it('eleven elements cost ONE tool call — the regression guard for the read storm', async () => {
    const { dispatch, seen } = fakeDispatch();
    const tools = createDomTools(dispatch);
    const selectors = Array.from({ length: 11 }, (_, i) => `#el-${i}`);
    const result = (await tools.getStyles.execute?.(
      { selectors },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;
    expect(Object.keys(styles(result))).toHaveLength(11);
    expect(seen).toHaveLength(11); // …eleven bus round-trips, but ONE model step.
    expect(result.ok).toBe(true);
  });

  it('projects to `props`, so a read costs what was asked for and not 22 properties', async () => {
    const { dispatch } = fakeDispatch();
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      { selectors: ['#a', '.b'], props: ['color', 'font-size'] },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;

    expect(styles(result)['#a']).toEqual({ color: 'rgb(0, 0, 0)', 'font-size': '13px' });
    expect(styles(result)['.b']).toEqual({ color: 'rgb(0, 0, 0)', 'font-size': '13px' });
    // The saving is real: the unprojected result carries every property.
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(ALL_PROPS).length * 2);
  });

  it('drops an unknown prop rather than erroring or substituting something else', async () => {
    const { dispatch } = fakeDispatch();
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      { selectors: ['#a'], props: ['color', 'not-a-real-property'] },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;
    expect(styles(result)['#a']).toEqual({ color: 'rgb(0, 0, 0)' });
    expect(result.ok).toBe(true);
  });

  it('still accepts a single `selector` — nothing that already calls this breaks', async () => {
    const { dispatch, seen } = fakeDispatch();
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      { selector: '#solo' },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;
    expect(seen).toHaveLength(1);
    expect(styles(result)['#solo']).toBeDefined();
  });

  it('one bad selector out of three costs only that one', async () => {
    const { dispatch } = fakeDispatch({
      '.missing': { type: 'tool-result', ok: false, error: 'no element matches the selector' },
    });
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      { selectors: ['#a', '.missing', '.b'] },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;

    expect(result.ok).toBe(true);
    expect(Object.keys(styles(result))).toEqual(['#a', '.b']);
    const failed = (result.data as { failed?: Record<string, string> }).failed;
    expect(failed?.['.missing']).toContain('no element matches');
  });

  it('fails only when NOTHING matched, and says so', async () => {
    const { dispatch } = fakeDispatch({
      '#gone': { type: 'tool-result', ok: false, error: 'no element matches the selector' },
    });
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      { selectors: ['#gone'] },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('None of the selectors matched');
  });

  it('is total: naming neither selector nor selectors returns an error, never throws', async () => {
    const { dispatch, seen } = fakeDispatch();
    const tools = createDomTools(dispatch);
    const result = (await tools.getStyles.execute?.(
      {},
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    )) as ToolResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('`selectors`');
    expect(seen).toHaveLength(0);
  });

  it('de-duplicates, so a repeated selector is not read twice', async () => {
    const { dispatch, seen } = fakeDispatch();
    const tools = createDomTools(dispatch);
    await tools.getStyles.execute?.(
      { selectors: ['#a', '#a', '.b'], selector: '#a' },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    );
    expect(seen).toHaveLength(2);
  });

  it('carries tab/frame addressing through to every fanned-out message', async () => {
    const { dispatch, seen } = fakeDispatch();
    const tools = createDomTools(dispatch);
    await tools.getStyles.execute?.(
      { selectors: ['#a', '.b'], tabId: 9, frameId: 3 },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's execute options are not under test
      {} as any,
    );
    for (const msg of seen) {
      expect(msg).toMatchObject({ tabId: 9, frameId: 3 });
    }
  });
});
