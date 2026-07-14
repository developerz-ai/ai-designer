import { describe, expect, it } from 'vitest';
import { describePage } from '@/dom/describe';

// describe.ts unit: turn a page/region into a compact, token-bounded *text* description. Pure DOM in
// (jsdom), plain string out — no chrome.*. Layout = structural skeleton; content = salient copy. The
// vision `scene` mode lives in the SW and is intentionally not exercised here.

function mount(html: string): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

const PAGE = `
  <header aria-label="Site header"><h1>Acme</h1></header>
  <nav aria-label="Primary">
    <a href="/">Home</a><a href="/pricing">Pricing</a>
  </nav>
  <main>
    <h2>Features</h2>
    <button>Sign up</button>
    <button aria-label="Log in">Enter</button>
    <a href="/docs">Docs</a>
    <p>Acme helps teams ship faster.</p>
    <p>Second paragraph.</p>
  </main>
  <footer><a href="/tos">Terms</a></footer>`;

describe('describePage — layout', () => {
  it('lists landmarks in document order with per-region component counts', () => {
    mount(PAGE);
    const { mode, text } = describePage(document, 'layout');
    expect(mode).toBe('layout');
    expect(text).toContain('Layout: banner › navigation › main › contentinfo');
    expect(text).toContain('- banner "Site header": 1 heading');
    expect(text).toContain('- navigation "Primary": 2 links');
    expect(text).toContain('- main "Features": 1 heading, 2 buttons, 1 link');
  });

  it('appends an indented heading outline', () => {
    mount(PAGE);
    const { text } = describePage(document, 'layout');
    expect(text).toContain('Headings:');
    expect(text).toContain('h1 Acme');
    expect(text).toContain('  h2 Features');
  });

  it('falls back to a marker when there is nothing structural', () => {
    mount('<div><span>hi</span></div>');
    expect(describePage(document, 'layout').text).toBe('No landmarks or headings found.');
  });
});

describe('describePage — content', () => {
  it('summarizes title, description, headings, controls and copy', () => {
    mount(PAGE);
    // Set the meta first, then the title — the title setter appends its <title> to <head>, so it
    // must not be clobbered by a later head.innerHTML assignment.
    document.head.innerHTML = '<meta name="description" content="Acme ships faster." />';
    document.title = 'Acme — Home';
    const { mode, text } = describePage(document, 'content');
    expect(mode).toBe('content');
    expect(text).toContain('Title: Acme — Home');
    expect(text).toContain('Description: Acme ships faster.');
    expect(text).toContain('Headings: Acme; Features');
    // aria-label wins over the button's own text ("Enter" -> "Log in").
    expect(text).toContain('Buttons: Sign up; Log in');
    expect(text).toContain('Links: Home; Pricing; Docs; Terms');
    expect(text).toContain('Copy: Acme helps teams ship faster. Second paragraph.');
  });

  it('scopes to a passed region and omits document-only fields', () => {
    mount(PAGE);
    const main = document.querySelector('main');
    if (!main) throw new Error('missing main');
    const { text } = describePage(main, 'content');
    expect(text).toContain('Links: Docs');
    expect(text).not.toContain('Home'); // outside <main>
    expect(text).not.toContain('Title:');
  });

  it('falls back to a marker when there is no salient text', () => {
    mount('<div style="width:1px"></div>');
    expect(describePage(document, 'content').text).toBe('No salient text content found.');
  });
});

describe('describePage — bounds', () => {
  it('clips the description to the char budget', () => {
    mount(PAGE);
    const { text } = describePage(document, 'content', { maxChars: 24 });
    expect(text.length).toBeLessThanOrEqual(24);
    expect(text.endsWith('…')).toBe(true);
  });
});
