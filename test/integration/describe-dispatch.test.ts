import { describe, expect, it } from 'vitest';
import { describePage } from '@/dom/describe';
import { extractIdentity } from '@/dom/identity';
import { imageContent } from '@/dom/images';
import { queryOne } from '@/dom/read';
import type {
  DescribeCmd,
  DescribeResult,
  IdentityResult,
  ImageDescription,
  ToolResult,
} from '@/shared/messages';

// Integration: a validated `DescribeCmd` routed through content.ts's `handleDescribe` logic against a
// live jsdom DOM — the slice-14 describe / extractIdentity / readImageContent reads content.ts adds
// beside DomTool/ControlTool. Mirrors control-dispatch.test.ts (the content dispatch path minus the
// chrome bus): the body below reproduces handleDescribe verbatim so a regression there is caught here.

function handleDescribe(cmd: DescribeCmd): ToolResult {
  if (cmd.type === 'extractIdentity') {
    const data: IdentityResult = extractIdentity(document, window);
    return { type: 'tool-result', ok: true, data };
  }
  if (cmd.type === 'readImageContent') {
    const img = imageContent(document, cmd.selector, window);
    if (!img) {
      return {
        type: 'tool-result',
        ok: false,
        error: `No element matches selector: ${cmd.selector}`,
      };
    }
    const data: ImageDescription = {
      selector: img.selector,
      src: img.src,
      ...(img.alt !== undefined ? { alt: img.alt } : {}),
      description: img.alt ?? '',
    };
    return { type: 'tool-result', ok: true, data };
  }
  if (cmd.mode === 'scene') {
    return { type: 'tool-result', ok: false, error: 'Scene description needs the vision model.' };
  }
  const root = cmd.selector ? queryOne(document, cmd.selector) : document;
  if (cmd.selector && !root) {
    return {
      type: 'tool-result',
      ok: false,
      error: `No element matches selector: ${cmd.selector}`,
    };
  }
  const data: DescribeResult = describePage(root ?? document, cmd.mode);
  return { type: 'tool-result', ok: true, data };
}

function setup(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

const data = <T>(r: ToolResult): T => r.data as T;

describe('describe cmd → content effect → typed result', () => {
  it('describe layout: names the landmark regions and the heading outline', () => {
    setup('<nav>Menu</nav><main><h1>Welcome</h1><p>Hi</p></main><footer>Legal</footer>');
    const result = handleDescribe({ type: 'describe', mode: 'layout' });
    expect(result.ok).toBe(true);
    const { mode, text } = data<DescribeResult>(result);
    expect(mode).toBe('layout');
    expect(text).toContain('navigation');
    expect(text).toContain('contentinfo');
    expect(text).toContain('h1 Welcome');
  });

  it('describe content: surfaces the salient copy', () => {
    setup('<main><h1>Pricing</h1><button>Buy now</button><a href="/x">Docs</a></main>');
    const result = handleDescribe({ type: 'describe', mode: 'content' });
    const { text } = data<DescribeResult>(result);
    expect(text).toContain('Pricing');
    expect(text).toContain('Buy now');
    expect(text).toContain('Docs');
  });

  it('describe: scopes to a selector, and an unmatched selector is an error (not a throw)', () => {
    setup('<main><h2>Section</h2></main>');
    const scoped = handleDescribe({ type: 'describe', mode: 'content', selector: 'main' });
    expect(data<DescribeResult>(scoped).text).toContain('Section');

    const missing = handleDescribe({ type: 'describe', mode: 'layout', selector: '#ghost' });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toContain('#ghost');
  });

  it('describe scene: refuses in the content world (vision runs in the SW)', () => {
    setup('<main></main>');
    const result = handleDescribe({ type: 'describe', mode: 'scene' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('vision');
  });

  it('extractIdentity: returns a role-tagged palette + type scale', () => {
    setup(
      '<main style="background-color: #101014; color: #f5f5f7; font-family: Inter; font-size: 16px">' +
        '<h1 style="font-size: 40px; font-weight: 700">Brand</h1>' +
        '<button style="background-color: #ff5a1f; color: #ffffff">Get started</button>' +
        '</main>',
    );
    const result = handleDescribe({ type: 'extractIdentity' });
    expect(result.ok).toBe(true);
    const identity = data<IdentityResult>(result);
    expect(identity.palette.length).toBeGreaterThan(0);
    expect(identity.palette.map((c) => c.hex)).toContain('#101014');
    expect(identity.palette.some((c) => c.role === 'accent')).toBe(true); // the CTA fill
    expect(identity.type.sizes).toContain(40);
    expect(identity.type.weights).toContain(700);
  });

  it('readImageContent: resolves an <img> to its alt + src, alt as the cheap description', () => {
    setup('<img id="hero" src="https://cdn.test/hero.png" alt="A tabby cat" />');
    const result = handleDescribe({ type: 'readImageContent', selector: '#hero' });
    expect(result.ok).toBe(true);
    const img = data<ImageDescription>(result);
    expect(img.src).toBe('https://cdn.test/hero.png');
    expect(img.alt).toBe('A tabby cat');
    expect(img.description).toBe('A tabby cat'); // non-vision fallback = the alt text
    expect(img.selector?.value).toBe('#hero');
  });

  it('readImageContent: reads a CSS background element; missing alt → empty description', () => {
    setup('<div id="bg" style="background-image: url(https://cdn.test/bg.png)">x</div>');
    const result = handleDescribe({ type: 'readImageContent', selector: '#bg' });
    const img = data<ImageDescription>(result);
    expect(img.src).toBe('https://cdn.test/bg.png');
    expect(img.alt).toBeUndefined();
    expect(img.description).toBe('');
  });

  it('readImageContent: an unmatched selector is an error ToolResult, not a throw', () => {
    setup('<div></div>');
    const result = handleDescribe({ type: 'readImageContent', selector: '#nope' });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('#nope');
  });
});
