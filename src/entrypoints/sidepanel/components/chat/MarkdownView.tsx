import { For, Match, Show, Switch } from 'solid-js';
import type { MdBlock, MdInline } from './markdown';
import { parseMarkdown } from './markdown';

// Walks the pure `markdown.ts` AST into real Solid elements — every string ends up in a JSX text
// node, never `innerHTML`, so this stays XSS-safe by construction (CLAUDE.md "No remote code, no
// `eval`"). Presentational only: no parsing logic lives here (SRP — that's `markdown.ts`).
export interface MarkdownViewProps {
  text: string;
}

export function MarkdownView(props: MarkdownViewProps) {
  return (
    <div class="dz-markdown">
      <For each={parseMarkdown(props.text)}>{(block) => <Block block={block} />}</For>
    </div>
  );
}

function Block(props: { block: MdBlock }) {
  return (
    <Switch fallback={<Paragraph block={props.block as ParagraphT} />}>
      <Match when={props.block.type === 'code-block'}>
        <CodeBlock block={props.block as CodeBlockT} />
      </Match>
      <Match when={props.block.type === 'heading'}>
        <Heading block={props.block as HeadingT} />
      </Match>
      <Match when={props.block.type === 'list'}>
        <ListBlock block={props.block as ListT} />
      </Match>
    </Switch>
  );
}

type CodeBlockT = Extract<MdBlock, { type: 'code-block' }>;
type HeadingT = Extract<MdBlock, { type: 'heading' }>;
type ListT = Extract<MdBlock, { type: 'list' }>;
type ParagraphT = Extract<MdBlock, { type: 'paragraph' }>;

function Paragraph(props: { block: ParagraphT }) {
  return (
    <p>
      <Inline nodes={props.block.children} />
    </p>
  );
}

function CodeBlock(props: { block: CodeBlockT }) {
  return (
    <pre class="dz-markdown__code-block">
      <code>{props.block.value}</code>
    </pre>
  );
}

function Heading(props: { block: HeadingT }) {
  return (
    <Switch
      fallback={
        <h4>
          <Inline nodes={props.block.children} />
        </h4>
      }
    >
      <Match when={props.block.level === 1}>
        <h2>
          <Inline nodes={props.block.children} />
        </h2>
      </Match>
      <Match when={props.block.level === 2}>
        <h3>
          <Inline nodes={props.block.children} />
        </h3>
      </Match>
    </Switch>
  );
}

function ListBlock(props: { block: ListT }) {
  return (
    <Show
      when={props.block.ordered}
      fallback={
        <ul>
          <For each={props.block.items}>
            {(item) => (
              <li>
                <Inline nodes={item} />
              </li>
            )}
          </For>
        </ul>
      }
    >
      <ol>
        <For each={props.block.items}>
          {(item) => (
            <li>
              <Inline nodes={item} />
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}

function Inline(props: { nodes: MdInline[] }) {
  return <For each={props.nodes}>{(node) => <InlineNode node={node} />}</For>;
}

function InlineNode(props: { node: MdInline }) {
  const node = props.node;
  switch (node.type) {
    case 'text':
      return <>{node.value}</>;
    case 'code':
      return <code class="dz-markdown__code">{node.value}</code>;
    case 'strong':
      return (
        <strong>
          <Inline nodes={node.children} />
        </strong>
      );
    case 'em':
      return (
        <em>
          <Inline nodes={node.children} />
        </em>
      );
    case 'link':
      return (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          <Inline nodes={node.children} />
        </a>
      );
    default:
      return null;
  }
}
