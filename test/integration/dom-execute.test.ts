import { describe, expect, it } from 'vitest';
import { createDomExecutor, type DomExecutor } from '@/dom/execute';
import { createMutator, MARKER_ATTR } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import type { ContentToSw, QueryResult, ToolResult } from '@/shared/messages';

// Integration: a validated DomTool routed through the real executor + mutator + recorder against a
// live jsdom DOM, asserting the ToolResult shape and that mutations record + reverse. This is the
// content script's dispatch path minus the chrome bus (screenshot's async SW round-trip is the
// only piece the entrypoint owns and is covered by the loaded-extension e2e).

function setup(html: string): { exec: DomExecutor['exec']; emitted: ContentToSw[] } {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const emitted: ContentToSw[] = [];
  const recorder = createRecorder(
    (m) => emitted.push(m),
    () => 0,
  );
  const executor = createDomExecutor({ mutator: createMutator(document), recorder, doc: document });
  return { exec: executor.exec, emitted };
}

const data = <T>(r: ToolResult): T => r.data as T;

describe('DomTool execute — reads', () => {
  it('query returns a stable selector per match and never errors', () => {
    const { exec } = setup('<button data-testid="cta">Buy</button>');
    const result = exec({ type: 'query', selector: 'button' });
    expect(result.ok).toBe(true);
    expect(data<QueryResult>(result).matches[0]).toMatchObject({
      value: '[data-testid="cta"]',
      strategy: 'data-attr',
    });
  });

  it('getStyles projects the computed subset and echoes the resilient selector', () => {
    const { exec } = setup('<p id="p" style="display: flex">x</p>');
    const result = exec({ type: 'getStyles', selector: '#p' });
    expect(result.ok).toBe(true);
    expect(result.selector?.value).toBe('#p');
    expect(data<{ styles: Record<string, string> }>(result).styles.display).toBe('flex');
  });

  it('a11ySnapshot returns the role/name tree', () => {
    const { exec } = setup('<nav id="n"><a href="/">Home</a></nav>');
    const result = exec({ type: 'a11ySnapshot', selector: '#n' });
    expect(data<{ tree: { role: string } }>(result).tree.role).toBe('navigation');
  });

  it('an unmatched selector is an error ToolResult, not a throw', () => {
    const { exec } = setup('<div></div>');
    const result = exec({ type: 'getStyles', selector: '#ghost' });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('#ghost');
  });
});

describe('DomTool execute — mutations record + reverse', () => {
  it('setStyle mutates via the injected sheet, records an event, and reports computed + selector', () => {
    const { exec, emitted } = setup('<button id="cta">Buy</button>');
    const result = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });

    expect(result.ok).toBe(true);
    expect(result.selector?.value).toBe('#cta');
    expect(data<Record<string, string>>(result).color).toBe('rgb(1, 2, 3)');
    // recorded on the bus…
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'setStyle' } });
    // …and applied through the overrides stylesheet, never inline.
    expect(document.getElementById('cta')?.getAttribute('style')).toBeNull();
    expect(document.getElementById('dz-designer-overrides')?.textContent).toContain('color');
  });

  it('setText replaces text and records it', () => {
    const { exec, emitted } = setup('<p id="t">before</p>');
    exec({ type: 'setText', selector: '#t', value: 'after' });
    expect(document.getElementById('t')?.textContent).toBe('after');
    expect(emitted[0]).toMatchObject({ type: 'recorder-event', event: { kind: 'setText' } });
  });

  it('undo reverses the last mutation and reports it; a second undo is empty', () => {
    const { exec } = setup('<p id="t">before</p>');
    exec({ type: 'setText', selector: '#t', value: 'after' });

    const undone = exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    expect(data<{ kind: string }>(undone).kind).toBe('setText');
    expect(document.getElementById('t')?.textContent).toBe('before');

    const empty = exec({ type: 'undo' });
    expect(empty).toMatchObject({ ok: false, error: 'Nothing to undo' });
  });

  it('undo of a setStyle drops the rule and the marker', () => {
    const { exec } = setup('<button id="cta">Buy</button>');
    exec({ type: 'setStyle', selector: '#cta', props: { color: 'red' } });
    exec({ type: 'undo' });
    expect(document.getElementById('cta')?.hasAttribute(MARKER_ATTR)).toBe(false);
    expect(document.getElementById('dz-designer-overrides')?.textContent).toBe('');
  });
});
