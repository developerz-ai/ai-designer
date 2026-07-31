import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from '@/entrypoints/sidepanel/components/chat/MarkdownView';

// What the assistant's answer actually renders as (#165). The parser has its own shape
// (`markdown.ts`); this covers the half that reaches the accessibility tree — heading levels,
// list semantics, fenced code — because that is what the prose styling now depends on.
//
// No JSX here on purpose: a Solid component is just a function of props, so calling it directly
// keeps this spec a plain `.ts` file while still mounting the real component.
function mount(text: string) {
  return render(() => MarkdownView({ text }));
}

describe('<MarkdownView> headings', () => {
  it('demotes markdown h1/h2 so the panel title stays the page h1', () => {
    mount('# Findings\n\n## Contrast\n\n### Buttons');

    expect(screen.getByRole('heading', { level: 2, name: 'Findings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Contrast' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: 'Buttons' })).toBeInTheDocument();
  });

  it('keeps inline emphasis inside a heading', () => {
    mount('## The **hero** section');

    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('The hero section');
    expect(heading.querySelector('strong')).toHaveTextContent('hero');
  });
});

describe('<MarkdownView> lists', () => {
  it('renders a bullet list as a list with one item per bullet', () => {
    mount('- first\n- second');

    const list = screen.getByRole('list');
    expect(list.tagName).toBe('UL');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'first',
      'second',
    ]);
  });

  it('renders a numbered list as an ordered list', () => {
    mount('1. first\n2. second');

    expect(screen.getByRole('list').tagName).toBe('OL');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  // Known limitation, asserted so it is visible rather than assumed: `markdown.ts` strips leading
  // indentation and flattens every bullet into one list (and `MdBlock`'s `list` has no slot for a
  // nested one), so an indented sub-bullet renders as a sibling. MarkdownView.scss already carries
  // the disc -> circle -> square nesting styles; this test is the tripwire that keeps them from
  // becoming permanently dead CSS.
  //
  // It cannot silently keep passing: both expectations are exact and both break on any nesting
  // implementation — an inner `<ul>` makes the list count 2, and it also puts the child's text
  // inside the parent `<li>`, making its textContent 'parentchild'. When this goes red, the fix
  // is to assert the nesting and check MarkdownView.scss's markers actually render.
  it('does NOT nest an indented sub-bullet yet — the parser flattens it', () => {
    mount('- parent\n  - child');

    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'parent',
      'child',
    ]);
  });
});

describe('<MarkdownView> code', () => {
  it('renders a fenced block as pre > code, preserving line breaks', () => {
    const { container } = mount('```css\n.cta {\n  color: red;\n}\n```');

    const block = container.querySelector('pre.dz-markdown__code-block');
    expect(block).not.toBeNull();
    expect(block?.querySelector('code')?.textContent).toBe('.cta {\n  color: red;\n}');
  });

  it('renders inline code as its own element inside the paragraph', () => {
    const { container } = mount('Set `color` on the button.');

    const code = container.querySelector('code.dz-markdown__code');
    expect(code).toHaveTextContent('color');
    expect(container.querySelector('p')).toHaveTextContent('Set color on the button.');
  });
});

describe('<MarkdownView> links', () => {
  it('renders an http link as an anchor that cannot reach back into the panel', () => {
    mount('See [the docs](https://developerz.ai/docs).');

    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://developerz.ai/docs');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('refuses a javascript: URL, leaving it as inert text', () => {
    mount('[click](javascript:alert(1))');

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('[click](javascript:alert(1))')).toBeInTheDocument();
  });
});
