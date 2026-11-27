import { beforeEach, describe, expect, it } from 'vitest';
import { adoptLiveEditState, type LiveEditHolder } from '@/dom/live-edit-state';
import { createMutator, MARKER_ATTR } from '@/dom/mutate';
import type { ContentToSw } from '@/shared/messages';

// The content script is re-injected into every open tab on EVERY service-worker boot (an MV3 worker
// idles out after ~30s), and the newest instance takes over from the old one. The live edits on the
// page — the mutator's overrides sheet and the recorder's undo log — must survive that takeover, or
// the next edit after an idle wipes every earlier one.

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`fixture missing: #${id}`);
  return found;
}

describe('adoptLiveEditState — content-script takeover', () => {
  beforeEach(() => mount('<p id="a">a</p><p id="b">b</p>'));

  it('keeps the earlier injection’s edits when a re-injection edits again', () => {
    const holder: LiveEditHolder = {};
    const first = adoptLiveEditState(holder, () => {});
    first.mutator.setStyle(el('a'), { color: 'rgb(255, 0, 0)' });

    const second = adoptLiveEditState(holder, () => {});
    second.mutator.setStyle(el('b'), { color: 'rgb(0, 0, 255)' });

    expect(getComputedStyle(el('a')).color).toBe('rgb(255, 0, 0)');
    expect(getComputedStyle(el('b')).color).toBe('rgb(0, 0, 255)');
  });

  it('keeps the undo log and routes recorder events to the NEWEST instance’s emit', () => {
    const holder: LiveEditHolder = {};
    const oldEvents: ContentToSw[] = [];
    const first = adoptLiveEditState(holder, (m) => oldEvents.push(m));
    const mutation = first.mutator.setStyle(el('a'), { color: 'rgb(255, 0, 0)' });
    first.recorder.record({ value: '#a', strategy: 'id', fragile: false }, mutation);

    const newEvents: ContentToSw[] = [];
    const second = adoptLiveEditState(holder, (m) => newEvents.push(m));
    expect(second.recorder.size()).toBe(1);
    oldEvents.length = 0;
    second.recorder.undo();
    // The edit is really reverted on the page, and the revert is reported to the NEW instance only.
    expect(getComputedStyle(el('a')).color).not.toBe('rgb(255, 0, 0)');
    expect(oldEvents).toHaveLength(0);
    expect(newEvents.map((m) => m.type)).toContain('recorder-revert');
  });

  it('is not fooled by a page element whose id names a state slot', () => {
    // DOM named access: `window.<id>` resolves to an element with that id. A string-keyed slot
    // would have "adopted" the element and left the executor with no mutator.
    document.body.insertAdjacentHTML('beforeend', '<div id="__dzDesignerLiveEdits"></div>');
    const state = adoptLiveEditState(window as unknown as LiveEditHolder, () => {});
    expect(typeof state.mutator.setStyle).toBe('function');
  });
});

describe('createMutator — a second mutator on the same document', () => {
  beforeEach(() => mount('<p id="a">a</p><p id="b">b</p>'));

  it('never reuses a marker an earlier mutator already stamped on the page', () => {
    // A fresh isolated world after an extension reload starts its own counter at 1; the corpse's
    // markers are still in the DOM, so a reused id would aim the new rule at the old element.
    createMutator(document).setStyle(el('a'), { color: 'rgb(255, 0, 0)' });
    createMutator(document).setStyle(el('b'), { color: 'rgb(0, 0, 255)' });
    expect(el('b').getAttribute(MARKER_ATTR)).not.toBe(el('a').getAttribute(MARKER_ATTR));
    expect(getComputedStyle(el('a')).color).not.toBe('rgb(0, 0, 255)');
  });
});

describe('createMutator — markers inside a shadow root', () => {
  it('never reuses a marker an earlier mutator stamped inside the same shadow root', () => {
    mount('<div id="host"></div>');
    const shadow = el('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p id="x">x</p><p id="y">y</p>';
    const x = shadow.getElementById('x') as HTMLElement;
    const y = shadow.getElementById('y') as HTMLElement;
    createMutator(document).setStyle(x, { color: 'rgb(255, 0, 0)' });
    createMutator(document).setStyle(y, { color: 'rgb(0, 0, 255)' });
    expect(y.getAttribute(MARKER_ATTR)).not.toBe(x.getAttribute(MARKER_ATTR));
  });
});
