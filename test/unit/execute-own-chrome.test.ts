import { describe, expect, it } from 'vitest';
import { createDomExecutor, type DomExecutor, type SyncDomTool } from '@/dom/execute';
import { createMutator, SHEET_ID } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import type { ContentToSw } from '@/shared/messages';

// #165 F2 — the editor's own chrome is not an editable target for ANY mutation.
//
// The own-chrome guard existed but was wired only to the STRUCTURAL ops (insert/move/remove), so
// `setText('#dz-designer-overrides', '* { background: url(https://attacker.example/x) }')` went
// straight through: the overrides sheet is a <style> with zero ELEMENT children, so the `leafOnly`
// guard passed it, and `el.textContent = value` turned our stylesheet into arbitrary page-wide CSS
// (a same-cookie remote fetch + a repaint-anything channel). It also desynced the mutator — the
// override map still held the real entries, so the next setStyle's re-render wiped the injected
// CSS and the recorded undo restored a STALE sheet, dropping every style edit made in between.

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

// Force the overrides sheet into existence (it is created lazily by the first setStyle).
function withSheet(): { exec: DomExecutor['exec']; emitted: ContentToSw[] } {
  const ctx = setup('<button id="cta">Buy</button>');
  ctx.exec({ type: 'setStyle', selector: '#cta', props: { color: 'red' } });
  return ctx;
}

const ownChrome = /overrides sheet|editor’s own UI/;

describe('own-chrome guard on content mutations', () => {
  it('refuses setText on the overrides sheet', () => {
    const { exec, emitted } = withSheet();
    const before = document.getElementById(SHEET_ID)?.textContent ?? '';
    emitted.length = 0; // drop the setStyle that materialized the sheet

    const result = exec({
      type: 'setText',
      selector: `#${SHEET_ID}`,
      value: '* { background-image: url(https://attacker.example/x.png) }',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(ownChrome);
    expect(document.getElementById(SHEET_ID)?.textContent).toBe(before);
    // Refused before the DOM was touched, so nothing was recorded either.
    expect(emitted.filter((m) => m.type === 'recorder-event')).toHaveLength(0);
  });

  it('refuses every content mutation on the overrides sheet', () => {
    const { exec } = withSheet();
    const tools: SyncDomTool[] = [
      { type: 'setStyle', selector: `#${SHEET_ID}`, props: { display: 'block' } },
      { type: 'setAttr', selector: `#${SHEET_ID}`, name: 'media', value: 'print' },
      { type: 'addClass', selector: `#${SHEET_ID}`, name: 'x' },
      { type: 'removeClass', selector: `#${SHEET_ID}`, name: 'x' },
    ];
    for (const tool of tools) {
      const result = exec(tool);
      expect([tool.type, result.ok]).toEqual([tool.type, false]);
      expect(result.error).toMatch(ownChrome);
    }
    expect(document.getElementById(SHEET_ID)?.getAttribute('media')).toBeNull();
  });

  it('refuses content mutations inside the picker / overlay hosts', () => {
    const { exec } = setup(
      '<div data-dz-designer="picker"><span id="p">x</span></div>' +
        '<div data-dz-designer="overlay"><span id="o">y</span></div>',
    );
    for (const id of ['p', 'o']) {
      const result = exec({ type: 'setText', selector: `#${id}`, value: 'hijacked' });
      expect([id, result.ok]).toEqual([id, false]);
      expect(result.error).toMatch(ownChrome);
      expect(document.getElementById(id)?.textContent).not.toBe('hijacked');
    }
  });

  it('still allows the same mutations on ordinary page content', () => {
    const { exec } = setup('<p id="copy">before</p>');
    expect(exec({ type: 'setText', selector: '#copy', value: 'after' }).ok).toBe(true);
    expect(exec({ type: 'setStyle', selector: '#copy', props: { color: 'red' } }).ok).toBe(true);
    expect(exec({ type: 'addClass', selector: '#copy', name: 'lead' }).ok).toBe(true);
    expect(document.getElementById('copy')?.textContent).toBe('after');
  });

  it('keeps the leafOnly guard for ordinary elements with children', () => {
    const { exec } = setup('<div id="wrap"><b>keep</b></div>');
    const result = exec({ type: 'setText', selector: '#wrap', value: 'flat' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('child element');
  });
});
