import { describe, expect, it } from 'vitest';
import { a11ySnapshot, cropBox, getStyles, query, queryOne, screenshotRect } from '@/dom/read';

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture missing: #${id}`);
  return el;
}

describe('query', () => {
  it('returns a stable, non-fragile selector for a data-testid element', () => {
    mount('<button data-testid="cta">Buy</button>');
    const { matches } = query(document, 'button');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.strategy).toBe('data-attr');
    expect(matches[0]?.value).toBe('[data-testid="cta"]');
    expect(matches[0]?.fragile).toBe(false);
  });

  it('flags an anonymous element with a fragile css-path', () => {
    mount('<section id="s"><span></span><span></span></section>');
    const { matches } = query(document, '#s span:nth-of-type(2)');
    expect(matches[0]?.strategy).toBe('css-path');
    expect(matches[0]?.fragile).toBe(true);
  });

  it('resolves one selector per match', () => {
    mount('<ul id="l"><li>a</li><li>b</li></ul>');
    expect(query(document, '#l li').matches).toHaveLength(2);
  });

  it('never throws on an invalid selector', () => {
    mount('<div></div>');
    expect(query(document, ':::bad').matches).toEqual([]);
    expect(queryOne(document, ':::bad')).toBeNull();
  });

  it('queryOne returns the first match', () => {
    mount('<p class="x">one</p><p class="x">two</p>');
    expect(queryOne(document, '.x')?.textContent).toBe('one');
  });
});

describe('getStyles', () => {
  it('projects the computed subset and reads a set value', () => {
    mount('<p id="p" style="display: flex">x</p>');
    expect(getStyles(byId('p'), ['display']).styles.display).toBe('flex');
  });

  it('drops empty props', () => {
    mount('<p id="p">x</p>');
    expect(getStyles(byId('p'), ['nonexistent-prop']).styles).toEqual({});
  });

  it('defaults to the relevant-props projection', () => {
    mount('<p id="p" style="display: block">x</p>');
    const { styles } = getStyles(byId('p'));
    expect(styles.display).toBe('block');
  });
});

describe('a11ySnapshot', () => {
  it('maps implicit roles and accessible names', () => {
    mount('<nav id="n"><a href="/">Home</a></nav>');
    const { tree } = a11ySnapshot(byId('n'));
    expect(tree.role).toBe('navigation');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.role).toBe('link');
    expect(tree.children[0]?.name).toBe('Home');
  });

  it('prefers aria-label for the accessible name', () => {
    mount('<button id="b" aria-label="Close dialog">x</button>');
    expect(a11ySnapshot(byId('b')).tree.name).toBe('Close dialog');
  });

  it('skips aria-hidden and non-visual nodes', () => {
    mount(
      '<div id="d"><span>seen</span><span aria-hidden="true">gone</span><script>1</script></div>',
    );
    const { tree } = a11ySnapshot(byId('d'));
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.name).toBe('seen');
  });

  it('bounds recursion depth', () => {
    mount('<div id="d"><div><div><div>deep</div></div></div></div>');
    const { tree } = a11ySnapshot(byId('d'), 1);
    expect(tree.children[0]?.children).toHaveLength(0);
  });
});

describe('screenshotRect', () => {
  it('returns the element rect and devicePixelRatio', () => {
    mount('<div id="d">x</div>');
    const shot = screenshotRect(byId('d'));
    expect(shot.rect).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(typeof shot.devicePixelRatio).toBe('number');
  });

  it('falls back to the viewport rect when no element is given', () => {
    const shot = screenshotRect();
    expect(shot.rect.width).toBe(window.innerWidth);
    expect(shot.rect.height).toBe(window.innerHeight);
  });
});

describe('cropBox', () => {
  it('scales a CSS-px rect to device px and clamps to the image', () => {
    // rect 10,20 100x50 @2x → 20,40 200x100, clamped inside a 800x600 frame.
    expect(cropBox({ x: 10, y: 20, width: 100, height: 50 }, 2, 800, 600)).toEqual({
      sx: 20,
      sy: 40,
      sw: 200,
      sh: 100,
    });
  });

  it('clamps width/height that would overflow the frame', () => {
    const box = cropBox({ x: 700, y: 500, width: 400, height: 400 }, 1, 800, 600);
    expect(box).toEqual({ sx: 700, sy: 500, sw: 100, sh: 100 });
  });

  it('returns null for an empty rect (keeps the full frame)', () => {
    expect(cropBox({ x: 0, y: 0, width: 0, height: 100 }, 2, 800, 600)).toBeNull();
  });

  it('returns null when the crop already spans the whole frame (no re-encode)', () => {
    expect(cropBox({ x: 0, y: 0, width: 400, height: 300 }, 2, 800, 600)).toBeNull();
  });

  it('returns null when the rect starts past the image edge', () => {
    expect(cropBox({ x: 900, y: 0, width: 100, height: 100 }, 1, 800, 600)).toBeNull();
  });
});
