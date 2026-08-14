import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDesignSystem } from '@/dom/page-ops/design-system';
import { readFormState, setField } from '@/dom/page-ops/forms';
import { createPageOps } from '@/dom/page-ops/index';
import { freezeMotion } from '@/dom/page-ops/motion';
import { PageOp } from '@/shared/page-ops';

// The page-operations library — the answer to "let the agent execute JS on the page" that executes
// no agent-authored JS. These assert the two properties that make it worth having: it answers
// questions the DOM and getComputedStyle cannot, and it never becomes a code-execution channel.

describe('the op vocabulary', () => {
  it('rejects an unknown operation instead of dispatching it', () => {
    expect(PageOp.safeParse({ op: 'evaluate', code: 'alert(1)' }).success).toBe(false);
  });

  it('has no parameter anywhere that carries code', () => {
    // The structural guarantee. If no op can accept a string that gets executed, no prompt can turn
    // this into eval. `pageCall` takes a PATH to a function the page already shipped, plus JSON.
    const call = PageOp.safeParse({ op: 'pageCall', path: 'chart.update', args: ['x', 1, true] });
    expect(call.success).toBe(true);
    // A function argument cannot even be expressed.
    expect(PageOp.safeParse({ op: 'pageCall', path: 'x.y', args: [{}] }).success).toBe(false);
  });
});

describe('geometry ops', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="m"><p id="p">hi</p></main>';
  });

  it('answers WHICH ancestor clips an element, which computed style cannot', () => {
    const clip = document.getElementById('m');
    const target = document.getElementById('p');
    if (!clip || !target) throw new Error('fixture');
    clip.style.overflow = 'hidden';
    // jsdom has no layout engine, so the rects are supplied.
    vi.spyOn(clip, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100) as DOMRect);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 400, 100) as DOMRect,
    );

    const ops = createPageOps({ doc: document, win: window });
    return ops.run({ op: 'overflow', selector: '#p' }).then((res) => {
      expect(res.ok).toBe(true);
      const data = res.data as { clippedBy: { selector: string } | null };
      expect(data.clippedBy?.selector).toBe('#m');
    });
  });

  it('names the ancestor that traps a z-index, not just the z-index', async () => {
    const wrapper = document.getElementById('m');
    const target = document.getElementById('p');
    if (!wrapper || !target) throw new Error('fixture');
    // The classic bug: a transform on an ancestor creates a stacking context, so no z-index on the
    // child can escape it. `getStyles` on the child shows `z-index: 9999` and explains nothing.
    wrapper.style.transform = 'translateZ(0)';
    target.style.position = 'relative';
    target.style.zIndex = '9999';

    const res = await createPageOps({ doc: document, win: window }).run({
      op: 'stacking',
      selector: '#p',
    });
    const data = res.data as { zIndex: string; containedBy: { reasons: string[] } | null };
    expect(data.zIndex).toBe('9999');
    expect(data.containedBy?.reasons.join(' ')).toContain('transform');
  });

  it('reports effective visibility from the ANCESTOR chain, not the element', async () => {
    const wrapper = document.getElementById('m');
    if (!wrapper) throw new Error('fixture');
    wrapper.style.display = 'none';

    const res = await createPageOps({ doc: document, win: window }).run({
      op: 'visibility',
      selector: '#p',
    });
    const data = res.data as { visible: boolean; reasons: string[] };
    expect(data.visible).toBe(false);
    expect(data.reasons.join(' ')).toContain('display: none');
  });

  it('reports a missing target as a readable error, never a throw', async () => {
    const res = await createPageOps({ doc: document, win: window }).run({
      op: 'box',
      selector: '#nope',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('#nope');
  });
});

describe('designSystem', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  function sheet(css: string): void {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  it('reads the AUTHORED tokens, which identity.ts cannot see once the cascade has run', () => {
    sheet(':root { --space-4: 1rem; --accent: #6366f1 } .card { color: var(--accent) }');
    const ds = readDesignSystem(document);
    const names = ds.tokens.map((t) => t.name);
    expect(names).toContain('--space-4');
    expect(ds.tokens.find((t) => t.name === '--accent')?.value).toBe('#6366f1');
  });

  it('prefers the :root declaration over a theme override as the token value', () => {
    sheet(':root { --bg: white } @media (prefers-color-scheme: dark) { :root { --bg: black } }');
    const ds = readDesignSystem(document);
    expect(ds.tokens.find((t) => t.name === '--bg')?.value).toBe('white');
    expect(ds.tokens.find((t) => t.name === '--bg')?.declarations).toBe(2);
  });

  it('reports the page own breakpoints, ascending', () => {
    sheet(
      '@media (min-width: 1024px) { a { color: red } } @media (max-width: 480px) { a { color: blue } }',
    );
    expect(readDesignSystem(document).breakpoints).toEqual(['480px', '1024px']);
  });

  it('counts a stylesheet it cannot read rather than silently reporting no tokens', () => {
    const style = document.createElement('style');
    document.head.appendChild(style);
    Object.defineProperty(style.sheet, 'cssRules', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const ds = readDesignSystem(document);
    expect(ds.stats.unreadableSheets).toBe(1);
  });
});

describe('forms', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="f">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required value="nope">
        <input id="pw" name="pw" type="password" value="hunter2">
        <input id="agree" name="agree" type="checkbox">
      </form>`;
  });

  it('reads a whole form including the validity the screenshot cannot show', () => {
    const form = document.getElementById('f');
    if (!form) throw new Error('fixture');
    const fields = readFormState(form);
    const email = fields.find((f) => f.name === 'email');
    expect(email?.label).toBe('Email');
    expect(email?.valid).toBe(false);
    expect(email?.validationMessage).not.toBe('');
  });

  it('never reads a password value back into the transcript', () => {
    const form = document.getElementById('f');
    if (!form) throw new Error('fixture');
    expect(readFormState(form).find((f) => f.name === 'pw')?.value).toBe('');
  });

  it('writes through the NATIVE prototype setter so a framework tracker sees it', () => {
    const el = document.getElementById('email');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    // Simulate React: shadow the prototype setter with an instance setter that records but does
    // not write. A naive `el.value = x` would satisfy the tracker and never update the DOM.
    let shadowed = '';
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () =>
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(el) ?? '',
      set: (v: string) => {
        shadowed = v;
      },
    });

    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    setField(el, { value: 'real@example.com' });

    // The instance setter was BYPASSED and the real value written…
    expect(shadowed).toBe('');
    expect(el.getAttribute('value')).not.toBe('real@example.com'); // attribute untouched, as in a browser
    expect(el.value).toBe('real@example.com');
    // …and the framework was told.
    expect(events).toEqual(['input', 'change']);
  });
});

describe('freezeMotion', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  it('installs one stylesheet and removes it on release', () => {
    expect(freezeMotion(document, true).frozen).toBe(true);
    freezeMotion(document, true); // idempotent — a second freeze must not stack a second sheet
    expect(document.querySelectorAll('style[data-dz-designer-css]')).toHaveLength(1);
    freezeMotion(document, false);
    expect(document.querySelectorAll('style[data-dz-designer-css]')).toHaveLength(0);
  });
});

describe('MAIN-world routing', () => {
  it('routes a MAIN-world op to the bridge rather than running it locally', async () => {
    const main = vi.fn().mockResolvedValue({ type: 'tool-result', ok: true, data: { x: 1 } });
    const res = await createPageOps({ doc: document, win: window, main }).run({
      op: 'pageValue',
      path: 'app.state',
    });
    expect(main).toHaveBeenCalledWith({ op: 'pageValue', path: 'app.state' });
    expect(res.ok).toBe(true);
  });

  it('says the bridge is missing instead of pretending the answer is empty', async () => {
    const res = await createPageOps({ doc: document, win: window }).run({
      op: 'frameworkState',
      selector: '#p',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('MAIN-world bridge');
  });
});
