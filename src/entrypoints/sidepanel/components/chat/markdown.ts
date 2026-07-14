// Minimal bundled markdown parser — no remote fetch, no HTML parsing, no `innerHTML` (CLAUDE.md
// "No remote code, no `eval`"; PR15 "bundled markdown (no remote)"). Deliberately a small subset
// (headings, bold/italic, inline+block code, links, lists, paragraphs) rather than a dependency:
// output is a plain data tree that `Message.tsx` walks into real Solid elements, so every byte of
// message text ends up in a JSX text node — never raw HTML — and stays XSS-safe by construction.
// Pure + side-effect-free (CLAUDE.md "no business logic in components") so it's unit-testable
// without mounting Solid.

export type MdInline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'link'; href: string; children: MdInline[] };

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: MdInline[] }
  | { type: 'code-block'; lang?: string; value: string }
  | { type: 'list'; ordered: boolean; items: MdInline[][] };

const SAFE_LINK_SCHEME = /^(https?|mailto):/i;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence (or EOF)
      blocks.push({ type: 'code-block', lang, value: body.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = (heading[1]?.length ?? 1) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const item = (lines[i] ?? '').match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
        if (!item) break;
        items.push(parseInline(item[1] ?? ''));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^```/.test(lines[i] ?? '')) {
      para.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
  }

  return blocks;
}

// Tokenizes one line's worth of inline markup: `code`, **strong**, *em*, [text](url). Scans
// left-to-right, greedily matching the earliest marker; anything else falls through as plain text.
function parseInline(text: string): MdInline[] {
  const nodes: MdInline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = rest.match(/`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/);
    if (!match || match.index === undefined) {
      nodes.push({ type: 'text', value: rest });
      break;
    }

    if (match.index > 0) {
      nodes.push({ type: 'text', value: rest.slice(0, match.index) });
    }

    if (match[1] !== undefined) {
      nodes.push({ type: 'code', value: match[1] });
    } else if (match[2] !== undefined) {
      nodes.push({ type: 'strong', children: parseInline(match[2]) });
    } else if (match[3] !== undefined) {
      nodes.push({ type: 'em', children: parseInline(match[3]) });
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const href = match[5];
      nodes.push(
        SAFE_LINK_SCHEME.test(href)
          ? { type: 'link', href, children: parseInline(match[4]) }
          : { type: 'text', value: match[0] },
      );
    }

    rest = rest.slice(match.index + match[0].length);
  }

  return nodes;
}
