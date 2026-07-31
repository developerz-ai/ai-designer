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

  it('falls back to a marker when there is genuinely nothing to count', () => {
    mount('<div><span>hi</span></div>');
    expect(describePage(document, 'layout').text).toContain('No landmarks, headings, or countable');
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
  it('clips the description to the char budget, and says that it did', () => {
    mount(PAGE);
    const { text } = describePage(document, 'content', { maxChars: 24 });
    const [body, ...rest] = text.split('\n[TRUNCATED');
    // The BODY still honours the budget…
    expect((body ?? '').length).toBeLessThanOrEqual(24);
    expect((body ?? '').endsWith('…')).toBe(true);
    // …and the cut is declared rather than left to look like a complete answer that just ended.
    expect(rest.length).toBe(1);
    expect(text).toContain('TRUNCATED at 24 characters');
  });
});

describe('truncation is self-declaring (the confabulation guard)', () => {
  // The shipped failure: on a link-dense page `describe(content)` returned one real title followed
  // by a bare `…(+127)`, and the agent answered "what's on this page?" by inventing the other
  // stories — plausible, specific, and wrong. A count is not a warning.
  function manyLinks(n: number): Document {
    const doc = document.implementation.createHTMLDocument('Link farm');
    for (let i = 0; i < n; i += 1) {
      const a = doc.createElement('a');
      a.setAttribute('href', `/story/${i}`);
      a.textContent = `Story number ${i}`;
      doc.body.appendChild(a);
    }
    return doc;
  }

  it('names truncation in words and says how to get the rest', () => {
    const { text } = describePage(manyLinks(140), 'content');
    expect(text).toContain('TRUNCATED');
    expect(text).toContain('not shown');
    // The remedy has to be in the payload — "there is more" without "here is how" leaves the
    // model guessing, which is the failure this exists for.
    expect(text).toMatch(/do not describe or summarize the items you cannot see/i);
    expect(text).toContain('maxChars');
    expect(text).toContain('selector');
  });

  it('does not cry truncation when everything fits', () => {
    const doc = document.implementation.createHTMLDocument('Small');
    const a = doc.createElement('a');
    a.setAttribute('href', '/one');
    a.textContent = 'Only link';
    doc.body.appendChild(a);
    const { text } = describePage(doc, 'content');
    expect(text).toContain('Only link');
    expect(text).not.toContain('TRUNCATED');
  });

  it('declares a whole-payload clip instead of ending mid-sentence', () => {
    const { text } = describePage(manyLinks(140), 'content', { maxChars: 120 });
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('TRUNCATED at 120 characters');
  });

  it('marks a truncated HEADING list too — it used to drop the tail silently', () => {
    const doc = document.implementation.createHTMLDocument('Headings');
    for (let i = 0; i < 30; i += 1) {
      const h = doc.createElement('h2');
      h.textContent = `Section ${i}`;
      doc.body.appendChild(h);
    }
    const { text } = describePage(doc, 'content');
    expect(text).toMatch(/Headings:.*TRUNCATED/s);
  });
});

describe('layout mode on a page with no semantic sectioning', () => {
  // Hacker News and a lot of internal tooling are table layouts: zero landmarks, zero headings.
  // The old answer was a bare "No landmarks or headings found." — no facts at all, which is
  // exactly when the model starts inventing them.
  it('falls back to what IS countable instead of a dead end', () => {
    const doc = document.implementation.createHTMLDocument('Table layout');
    doc.body.innerHTML =
      '<table><tr><td><a href="/a">one</a></td><td><a href="/b">two</a></td></tr>' +
      '<tr><td><img src="x.png" alt=""></td><td><button>Go</button></td></tr></table>';
    const { text } = describePage(doc, 'layout');
    expect(text).toContain('no semantic sectioning');
    expect(text).toContain('2 links');
    expect(text).toContain('1 button');
    // And it points at the tools that WILL answer the question.
    expect(text).toContain('describe(content)');
  });
});
