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

  it('never echoes a password it just wrote back into the transcript', () => {
    const el = document.getElementById('pw');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    // A page validator can quote the rejected value in its message, so neither the value nor the
    // message may reach the result. Assert the whole object, not just `value`.
    el.addEventListener('input', () => el.setCustomValidity(`"${el.value}" is too weak`));
    const result = setField(el, { value: 'correct horse battery staple' });
    expect(el.value).toBe('correct horse battery staple'); // written…
    expect(result).toEqual({
      value: '',
      checked: null,
      valid: false,
      validationMessage: '',
    }); // …but the entire result is secret-free, while the validity verdict survives
    expect(JSON.stringify(result)).not.toContain('correct horse battery staple');
  });

  it('never echoes the password through a page validator message either', () => {
    const el = document.getElementById('pw');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    el.addEventListener('input', () => el.setCustomValidity(`"${el.value}" is too weak`));
    const result = setField(el, { value: 'hunter3' });
    expect(result?.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter3');
  });

  it('…even when a handler flips the password field to text (show-password) during the write', () => {
    const el = document.getElementById('pw');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    el.addEventListener('input', () => {
      el.setCustomValidity(`"${el.value}" is too weak`);
      el.type = 'text';
    });
    const result = setField(el, { value: 'hunter5' });
    expect(JSON.stringify(result)).not.toContain('hunter5');
  });

  it('…even when a handler masks it, then reveals it again before validation', () => {
    document.body.innerHTML =
      '<form id="f4"><input id="p4" type="text" required pattern="x"></form>';
    const el = document.getElementById('p4') as HTMLInputElement;
    el.addEventListener('input', () => {
      el.type = 'password';
    });
    el.addEventListener('change', () => {
      el.type = 'text';
    });
    let invalidFired = false;
    el.addEventListener('invalid', () => {
      invalidFired = true;
    });
    el.addEventListener('change', () => el.setCustomValidity(`"${el.value}" rejected`));
    const result = setField(el, { value: 'hunter8' });
    expect(invalidFired).toBe(false); // validity is read without firing invalid
    expect(result?.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter8');
  });

  it('keeps secret detection across checked write events before a value write', () => {
    const el = document.getElementById('email');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    el.type = 'text';
    el.addEventListener(
      'input',
      () => {
        if (el.checked) el.type = 'password';
      },
      { once: true },
    );
    el.addEventListener('change', () => {
      el.type = 'text';
    });
    const result = setField(el, { checked: true, value: 'hunter9' });
    expect(el.value).toBe('hunter9');
    expect(result?.value).toBe('');
    expect(JSON.stringify(result)).not.toContain('hunter9');
  });

  it('detects masking on checked change before the value input reveals it', () => {
    const el = document.getElementById('email');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    let inputs = 0;
    el.addEventListener('change', () => {
      if (inputs === 1) el.type = 'password';
    });
    el.addEventListener('input', () => {
      inputs += 1;
      if (inputs === 2) {
        el.type = 'email';
        el.setCustomValidity(`rejected ${el.value}`);
      }
    });
    const result = setField(el, { checked: true, value: 'hunter10' });
    expect(el.value).toBe('hunter10');
    expect(result).toMatchObject({ value: '', validationMessage: '', valid: false });
    expect(JSON.stringify(result)).not.toContain('hunter10');
  });

  it.each(['off', '', 'on', 'section-login off'])(
    'withholds an unidentified text field with autocomplete %s on read and write',
    (autocomplete) => {
      document.body.innerHTML = `<form><input type="text" autocomplete="${autocomplete}" value="hunter11"></form>`;
      const form = document.querySelector('form');
      const el = document.querySelector('input');
      if (!form || !el) throw new Error('fixture');
      el.setCustomValidity('rejected hunter11');
      const fields = readFormState(form);
      expect(fields).toHaveLength(1);
      expect(fields[0]).toMatchObject({ value: '', validationMessage: '', valid: false });
      expect(JSON.stringify(fields)).not.toContain('hunter11');
      el.addEventListener('input', () => el.setCustomValidity(`rejected ${el.value}`));
      const result = setField(el, { value: 'hunter12' });
      expect(el.value).toBe('hunter12');
      expect(result).toMatchObject({ value: '', validationMessage: '', valid: false });
      expect(JSON.stringify(result)).not.toContain('hunter12');
    },
  );

  it('does not hide an ordinary field whose autocomplete only mentions password in a section', () => {
    document.body.innerHTML =
      '<form id="f5"><input id="e5" type="email" autocomplete="section-reset-password email" value="a@b.co"></form>';
    const form = document.getElementById('f5');
    if (!form) throw new Error('fixture');
    expect(readFormState(form)[0]?.value).toBe('a@b.co');
  });

  it('…and when a revealed password (text, autocomplete=current-password) is read', () => {
    document.body.innerHTML =
      '<form id="f2"><input id="rv" type="text" autocomplete="current-password" value="hunter6"></form>';
    const form = document.getElementById('f2');
    if (!form) throw new Error('fixture');
    const fields = readFormState(form);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'rv', value: '', valid: true });
    expect(JSON.stringify(fields)).not.toContain('hunter6');
    const el = document.getElementById('rv');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    el.addEventListener('input', () => el.setCustomValidity(`rejected ${el.value}`));
    const result = setField(el, { value: 'hunter13' });
    expect(el.value).toBe('hunter13');
    expect(result).toMatchObject({ value: '', validationMessage: '', valid: false });
    expect(JSON.stringify(result)).not.toContain('hunter13');
  });

  it('reads validity without firing invalid, so no page handler runs mid-read', () => {
    document.body.innerHTML = '<form id="f3"><input id="p3" type="password" required></form>';
    const el = document.getElementById('p3') as HTMLInputElement;
    el.value = 'hunter7';
    el.pattern = 'x';
    let invalidFired = false;
    el.addEventListener('invalid', () => {
      invalidFired = true;
      el.type = 'text';
    });
    el.setCustomValidity('"hunter7" is too weak'); // a page message quoting the password
    const form = document.getElementById('f3');
    if (!form) throw new Error('fixture');
    const [field] = readFormState(form);
    expect(field?.validationMessage).toBe('');
    expect(invalidFired).toBe(false);
    expect(field?.valid).toBe(false); // the verdict is still reported
    expect(JSON.stringify(field)).not.toContain('hunter7');
  });

  it('…even when the validator quotes the password and then clears the field', () => {
    const el = document.getElementById('pw');
    if (!(el instanceof HTMLInputElement)) throw new Error('fixture');
    el.required = true;
    el.addEventListener('change', () => {
      el.setCustomValidity(`"${el.value}" was rejected`);
      el.value = '';
    });
    const result = setField(el, { value: 'hunter4' });
    expect(result?.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter4');
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

  it('on release resumes only the animations IT paused, never one the page had paused', () => {
    const fake = (playState: AnimationPlayState) => {
      const a = {
        playState,
        pause() {
          a.playState = 'paused';
        },
        play() {
          a.playState = 'running';
        },
      };
      return a;
    };
    const running = fake('running');
    const pausedByPage = fake('paused');
    const doc = document as unknown as { getAnimations?: () => unknown[] };
    const real = doc.getAnimations;
    doc.getAnimations = () => [running, pausedByPage];
    try {
      freezeMotion(document, true);
      expect(running.playState).toBe('paused');
      expect(freezeMotion(document, false).paused).toBe(1);
      expect(running.playState).toBe('running');
      expect(pausedByPage.playState).toBe('paused'); // the page's own pause survives
    } finally {
      doc.getAnimations = real;
    }
  });

  it('resumes an animation whose target was detached at release (getAnimations omits it)', () => {
    const anim = {
      playState: 'running' as AnimationPlayState,
      pause() {
        anim.playState = 'paused';
      },
      play() {
        anim.playState = 'running';
      },
    };
    const doc = document as unknown as { getAnimations?: () => unknown[] };
    const real = doc.getAnimations;
    doc.getAnimations = () => [anim];
    try {
      freezeMotion(document, true);
      doc.getAnimations = () => []; // target detached: the document no longer lists it
      freezeMotion(document, false);
      expect(anim.playState).toBe('running');
    } finally {
      doc.getAnimations = real;
    }
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
