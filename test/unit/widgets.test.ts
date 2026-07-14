import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDriver } from '@/dom/widgets';
import type { ToolResult, WidgetActed } from '@/shared/messages';

// Unit (jsdom): the ARIA-anchored widget recipes drive a live DOM through realistic event sequences.
// `settle` is injected to resolve its predicate synchronously (options/dialogs render on the triggering
// event in these fixtures), so no real timer is involved. jsdom doesn't implement scrollIntoView — spy
// it to a no-op, as interact.test.ts does.

const driver = createWidgetDriver({ settle: (predicate) => Promise.resolve(predicate()) });
const acted = (result: ToolResult): WidgetActed => result.data as WidgetActed;

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('toggle', () => {
  it('clicks a switch that is not yet in the target state', async () => {
    mount('<button id="t" role="switch" aria-checked="false">Wi-Fi</button>');
    const el = byId('t');
    el.addEventListener('click', () =>
      el.setAttribute(
        'aria-checked',
        el.getAttribute('aria-checked') === 'true' ? 'false' : 'true',
      ),
    );

    const result = await driver.run({ type: 'toggle', selector: '#t', on: true });

    expect(result.ok).toBe(true);
    expect(el.getAttribute('aria-checked')).toBe('true');
    expect(acted(result).reached).toBe(true);
  });

  it('is a no-op when the switch already holds the target state', async () => {
    mount('<button id="t" role="switch" aria-checked="true">Wi-Fi</button>');
    const el = byId('t');
    const onClick = vi.fn();
    el.addEventListener('click', onClick);

    const result = await driver.run({ type: 'toggle', selector: '#t', on: true });

    expect(onClick).not.toHaveBeenCalled();
    expect(acted(result).reached).toBe(true);
  });

  it('toggles a native checkbox via its default action', async () => {
    mount('<input id="c" type="checkbox" />');
    const result = await driver.run({ type: 'toggle', selector: '#c', on: true });
    expect((byId('c') as HTMLInputElement).checked).toBe(true);
    expect(acted(result).reached).toBe(true);
  });
});

describe('tabs', () => {
  it('selects the tab whose label matches; reached tracks the app response', async () => {
    mount(
      `<div role="tablist" id="tabs">
        <button role="tab" aria-selected="true">Overview</button>
        <button role="tab" aria-selected="false">Billing</button>
      </div>`,
    );
    // A realistic tab widget manages aria-selected on click; the driver reads it, never writes it.
    const tabEls = document.querySelectorAll('[role="tab"]');
    for (const tab of tabEls) {
      tab.addEventListener('click', () => {
        for (const t of tabEls) t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
    }

    const result = await driver.run({ type: 'tabs', selector: '#tabs', value: 'Billing' });

    expect(tabEls[0]?.getAttribute('aria-selected')).toBe('false');
    expect(tabEls[1]?.getAttribute('aria-selected')).toBe('true');
    expect(acted(result).reached).toBe(true);
    expect(acted(result).state?.selected).toBe('Billing');
  });

  it('reports reached:false when the app does not reflect the selection', async () => {
    mount(
      `<div role="tablist" id="tabs">
        <button role="tab" aria-selected="false">One</button>
        <button role="tab" aria-selected="false">Two</button>
      </div>`,
    );
    const result = await driver.run({ type: 'tabs', selector: '#tabs', value: 'Two' });
    expect(acted(result).reached).toBe(false); // honest signal — agent can fall back to vision
  });

  it('falls back to a numeric index when no label matches', async () => {
    mount(
      `<div role="tablist" id="tabs">
        <button role="tab">One</button><button role="tab">Two</button>
      </div>`,
    );
    const result = await driver.run({ type: 'tabs', selector: '#tabs', value: '1' });
    expect(acted(result).state?.selected).toBe('Two');
  });
});

describe('combobox', () => {
  it('types, waits for options, and chooses the matching one', async () => {
    mount(
      `<input id="c" role="combobox" aria-controls="lb" />
       <ul id="lb" role="listbox">
         <li role="option">Apple</li><li role="option">Banana</li>
       </ul>`,
    );

    const chosen = vi.fn();
    document.querySelectorAll('[role="option"]')[1]?.addEventListener('click', chosen);

    const result = await driver.run({ type: 'combobox', selector: '#c', value: 'Banana' });

    expect(result.ok).toBe(true);
    expect(chosen).toHaveBeenCalledOnce(); // the real option handler fired
    expect((byId('c') as HTMLInputElement).value).toBe('Banana');
    expect(acted(result).state?.value).toBe('Banana');
  });

  it('errors when no option matches', async () => {
    mount(
      `<input id="c" role="combobox" aria-controls="lb" />
       <ul id="lb" role="listbox"><li role="option">Apple</li></ul>`,
    );
    const result = await driver.run({ type: 'combobox', selector: '#c', value: 'Cherry' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cherry');
  });
});

describe('slider', () => {
  it('sets a native range input to the clamped value', async () => {
    mount('<input id="s" type="range" min="0" max="100" value="0" />');
    const result = await driver.run({ type: 'slider', selector: '#s', value: 150 });
    expect((byId('s') as HTMLInputElement).value).toBe('100'); // clamped to max
    expect(acted(result).reached).toBe(true);
  });

  it('arrow-keys a role=slider toward the target value', async () => {
    mount(
      '<div id="s" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="10" aria-valuenow="0"></div>',
    );
    const el = byId('s');
    el.addEventListener('keydown', (e) => {
      const now = Number(el.getAttribute('aria-valuenow'));
      if (e.key === 'ArrowRight') el.setAttribute('aria-valuenow', String(now + 1));
      if (e.key === 'ArrowLeft') el.setAttribute('aria-valuenow', String(now - 1));
    });

    const result = await driver.run({ type: 'slider', selector: '#s', value: 3 });

    expect(el.getAttribute('aria-valuenow')).toBe('3');
    expect(acted(result).reached).toBe(true);
  });
});

describe('modal', () => {
  it('opens a dialog from a trigger and focuses it', async () => {
    mount('<button id="open">Open</button>');
    byId('open').addEventListener('click', () => {
      const dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.innerHTML = '<button>Confirm</button>';
      document.body.appendChild(dlg);
    });

    const result = await driver.run({ type: 'modal', selector: '#open', action: 'open' });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(acted(result).state?.open).toBe('true');
  });

  it('confirms a dialog by its confirm control', async () => {
    mount('<div id="dlg" role="dialog"><button>Cancel</button><button>Save</button></div>');
    const saved = vi.fn();
    const buttons = document.querySelectorAll('#dlg button');
    buttons[1]?.addEventListener('click', saved);

    const result = await driver.run({ type: 'modal', selector: '#dlg', action: 'confirm' });

    expect(saved).toHaveBeenCalledOnce();
    expect(acted(result).reached).toBe(true);
  });

  it('dismisses a dialog and reports it closed', async () => {
    mount('<div id="dlg" role="dialog"><button>Close</button></div>');
    const dlg = byId('dlg');
    document.querySelector('#dlg button')?.addEventListener('click', () => dlg.remove());

    const result = await driver.run({ type: 'modal', selector: '#dlg', action: 'dismiss' });

    expect(document.getElementById('dlg')).toBeNull();
    expect(acted(result).reached).toBe(true);
  });
});

describe('carousel', () => {
  it('clicks the next control the requested number of times', async () => {
    mount('<div id="c" class="carousel"><button aria-label="Next slide">›</button></div>');
    let advanced = 0;
    document.querySelector('[aria-label="Next slide"]')?.addEventListener('click', () => {
      advanced += 1;
    });

    const result = await driver.run({
      type: 'carousel',
      selector: '#c',
      direction: 'next',
      times: 3,
    });

    expect(advanced).toBe(3);
    expect(acted(result).state?.times).toBe('3');
  });
});

describe('dragDrop', () => {
  it('fires a pointer + HTML5 drop sequence onto the target', async () => {
    mount('<div id="src" draggable="true">card</div><div id="dst">column</div>');
    const dropped = vi.fn();
    const movedTo = vi.fn();
    byId('dst').addEventListener('drop', dropped);
    byId('dst').addEventListener('mouseup', movedTo);

    const result = await driver.run({ type: 'dragDrop', selector: '#src', to: '#dst' });

    expect(dropped).toHaveBeenCalledOnce();
    expect(movedTo).toHaveBeenCalledOnce();
    expect(acted(result).state?.to).toBe('#dst');
  });

  it('errors when the drop target is missing', async () => {
    mount('<div id="src">card</div>');
    const result = await driver.run({ type: 'dragDrop', selector: '#src', to: '#ghost' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('#ghost');
  });
});

describe('datetime', () => {
  it('navigates months then picks the target day', async () => {
    mount('<button id="dt">Pick a date</button>');
    let month = 6; // June (1-based)
    const names = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July'];
    const render = (cal: Element): void => {
      const days = Array.from(
        { length: 20 },
        (_, i) => `<button role="gridcell">${i + 1}</button>`,
      );
      cal.innerHTML = `<div class="caption">${names[month]} 2026</div>${days.join('')}`;
      const next = document.createElement('button');
      next.setAttribute('aria-label', 'Next month');
      next.addEventListener('click', () => {
        month += 1;
        render(cal);
      });
      cal.appendChild(next);
    };
    byId('dt').addEventListener('click', () => {
      const cal = document.createElement('div');
      cal.setAttribute('role', 'grid');
      document.body.appendChild(cal);
      render(cal);
    });

    const result = await driver.run({ type: 'datetime', selector: '#dt', date: '2026-07-14' });

    expect(result.ok).toBe(true);
    expect(acted(result).reached).toBe(true);
    expect(acted(result).state?.value).toBe('2026-07-14');
  });

  it('errors on a selector that matches nothing', async () => {
    mount('<div></div>');
    const result = await driver.run({ type: 'datetime', selector: '#ghost', date: '2026-07-14' });
    expect(result.ok).toBe(false);
  });
});
