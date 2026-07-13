import { describe, expect, it } from 'vitest';
import {
  A11yResult,
  A11ySnapshotInput,
  ContentToSw,
  DomTool,
  GetProviderResult,
  GetStylesInput,
  GetStylesResult,
  KeyStatusResult,
  McpListResult,
  McpServer,
  McpServerResult,
  ModelsResult,
  MutationEvent,
  PanelToSw,
  PickerCmd,
  ProviderConfig,
  QueryInput,
  QueryResult,
  SaveKeyResult,
  SaveProviderResult,
  ScreenshotInput,
  SetStyleInput,
  SetTextInput,
  SwToPanel,
  UndoInput,
} from '@/shared/messages';

// A valid StableSelector (fragile defaults to false) + a bounding rect, reused
// across the new bus-shape specs below.
const selector = { value: '[data-testid="cta"]', strategy: 'data-attr' as const };
const rect = { x: 0, y: 0, width: 120, height: 40 };

describe('message schemas', () => {
  it('accepts a valid user message', () => {
    const r = PanelToSw.safeParse({ type: 'user-message', text: 'make the CTA orange' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown panel message type', () => {
    const r = PanelToSw.safeParse({ type: 'nope', text: 'x' });
    expect(r.success).toBe(false);
  });

  it('parses a setStyle DOM tool', () => {
    const r = DomTool.safeParse({
      type: 'setStyle',
      selector: '[data-testid=cta]',
      props: { 'background-color': '#f97316' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects setStyle without props', () => {
    const r = DomTool.safeParse({ type: 'setStyle', selector: '#x' });
    expect(r.success).toBe(false);
  });
});

describe('settings message schemas', () => {
  it('accepts save-openrouter-key with a non-empty key', () => {
    expect(PanelToSw.safeParse({ type: 'save-openrouter-key', text: 'sk-or-x' }).success).toBe(
      true,
    );
  });

  it('rejects save-openrouter-key with an empty key', () => {
    expect(PanelToSw.safeParse({ type: 'save-openrouter-key', text: '' }).success).toBe(false);
  });

  it('accepts set-model and key-status / list-models / clear', () => {
    expect(PanelToSw.safeParse({ type: 'set-model', model: 'anthropic/claude' }).success).toBe(
      true,
    );
    expect(PanelToSw.safeParse({ type: 'key-status' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'list-models' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'clear-openrouter-key' }).success).toBe(true);
  });

  it('rejects set-model without a model id', () => {
    expect(PanelToSw.safeParse({ type: 'set-model' }).success).toBe(false);
  });

  it('parses the SW RPC response shapes', () => {
    expect(SaveKeyResult.safeParse({ ok: true, valid: true }).success).toBe(true);
    expect(KeyStatusResult.safeParse({ ok: true, present: false }).success).toBe(true);
    expect(ModelsResult.safeParse({ ok: true, models: [{ id: 'a/b', name: 'B' }] }).success).toBe(
      true,
    );
  });
});

describe('provider config message schemas (openai-compatible BYOK)', () => {
  const cfg = { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' };

  it('accepts save-provider carrying a ProviderConfig', () => {
    expect(PanelToSw.safeParse({ type: 'save-provider', config: cfg }).success).toBe(true);
  });

  it('accepts a keyless provider config (local endpoint)', () => {
    expect(
      ProviderConfig.safeParse({ baseURL: 'http://localhost:1234/v1', model: 'local' }).success,
    ).toBe(true);
  });

  it('rejects a provider config with a non-URL baseURL or an empty model', () => {
    expect(ProviderConfig.safeParse({ baseURL: 'not-a-url', model: 'gpt-4o' }).success).toBe(false);
    expect(ProviderConfig.safeParse({ baseURL: cfg.baseURL, model: '' }).success).toBe(false);
  });

  it('accepts get-provider and a baseURL-scoped list-models', () => {
    expect(PanelToSw.safeParse({ type: 'get-provider' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'list-models', baseURL: cfg.baseURL }).success).toBe(true);
  });

  it('parses the save/get-provider results; GetProviderResult.config never carries apiKey', () => {
    expect(SaveProviderResult.safeParse({ ok: true, valid: false, error: 'x' }).success).toBe(true);
    // A stray apiKey on the config is stripped by the omit schema, not echoed to the panel.
    const parsed = GetProviderResult.parse({ ok: true, config: { ...cfg }, hasKey: true });
    expect(parsed.config && 'apiKey' in parsed.config).toBe(false);
  });
});

describe('DomTool named per-tool input consts (derivable 1:1 by #11)', () => {
  it('exports each tool input as its own named const usable as an inputSchema', () => {
    expect(QueryInput.safeParse({ type: 'query', selector: '#hero' }).success).toBe(true);
    expect(GetStylesInput.safeParse({ type: 'getStyles', selector: '#hero' }).success).toBe(true);
    expect(ScreenshotInput.safeParse({ type: 'screenshot' }).success).toBe(true);
    expect(
      SetStyleInput.safeParse({ type: 'setStyle', selector: '#x', props: { color: 'red' } })
        .success,
    ).toBe(true);
    expect(SetTextInput.safeParse({ type: 'setText', selector: '#x', value: 'hi' }).success).toBe(
      true,
    );
    expect(A11ySnapshotInput.safeParse({ type: 'a11ySnapshot', selector: '#x' }).success).toBe(
      true,
    );
    expect(UndoInput.safeParse({ type: 'undo' }).success).toBe(true);
  });

  it('accepts the new a11ySnapshot member through the DomTool union', () => {
    expect(DomTool.safeParse({ type: 'a11ySnapshot', selector: '#hero' }).success).toBe(true);
  });

  it('rejects a11ySnapshot without a selector (malformed)', () => {
    expect(DomTool.safeParse({ type: 'a11ySnapshot' }).success).toBe(false);
  });

  it('does NOT admit picker commands into DomTool (PickerCmd stays separate)', () => {
    expect(DomTool.safeParse({ type: 'picker-start' }).success).toBe(false);
    expect(DomTool.safeParse({ type: 'picker-stop' }).success).toBe(false);
  });

  it('rejects a DomTool with an unknown discriminant', () => {
    expect(DomTool.safeParse({ type: 'teleport', selector: '#x' }).success).toBe(false);
  });
});

describe('PanelToSw picker commands (start-picker / stop-picker)', () => {
  it('accepts start-picker and stop-picker', () => {
    expect(PanelToSw.safeParse({ type: 'start-picker' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'stop-picker' }).success).toBe(true);
  });

  it('rejects a close-but-wrong picker discriminant (malformed)', () => {
    expect(PanelToSw.safeParse({ type: 'start-pickerr' }).success).toBe(false);
  });

  it('rejects a panel message missing the discriminant', () => {
    expect(PanelToSw.safeParse({}).success).toBe(false);
  });
});

describe('PickerCmd (SW -> content, kept out of DomTool)', () => {
  it('accepts picker-start and picker-stop', () => {
    expect(PickerCmd.safeParse({ type: 'picker-start' }).success).toBe(true);
    expect(PickerCmd.safeParse({ type: 'picker-stop' }).success).toBe(true);
  });

  it('rejects an unknown picker command (malformed discriminant)', () => {
    expect(PickerCmd.safeParse({ type: 'picker-pause' }).success).toBe(false);
  });

  it('rejects a picker command missing the discriminant', () => {
    expect(PickerCmd.safeParse({}).success).toBe(false);
  });
});

describe('MutationEvent (recorder event, consumed by #5/#9/#10)', () => {
  it('accepts a well-formed mutation event', () => {
    expect(
      MutationEvent.safeParse({
        kind: 'setStyle',
        selector,
        before: '#2563eb',
        after: '#f97316',
        ruleId: 'dz-rule-3',
        ts: 1719400000000,
      }).success,
    ).toBe(true);
  });

  it('accepts a mutation event without the optional ruleId', () => {
    expect(
      MutationEvent.safeParse({
        kind: 'setText',
        selector,
        before: 'Buy',
        after: 'Buy now',
        ts: 1719400000001,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown mutation kind (malformed)', () => {
    expect(
      MutationEvent.safeParse({ kind: 'teleportNode', selector, before: '', after: '', ts: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a mutation event with a non-numeric ts (malformed)', () => {
    expect(
      MutationEvent.safeParse({
        kind: 'setStyle',
        selector,
        before: 'a',
        after: 'b',
        ts: '2026-06-21T12:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects a mutation event whose selector is not a StableSelector (malformed)', () => {
    expect(
      MutationEvent.safeParse({ kind: 'setStyle', selector: '#x', before: 'a', after: 'b', ts: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a mutation event missing the kind discriminant', () => {
    expect(MutationEvent.safeParse({ selector, before: 'a', after: 'b', ts: 1 }).success).toBe(
      false,
    );
  });
});

describe('ContentToSw (content -> SW push: picker + recorder)', () => {
  it('accepts element-picked with candidates + rect and an optional styles snapshot', () => {
    expect(
      ContentToSw.safeParse({
        type: 'element-picked',
        candidates: [selector],
        rect,
        styles: { color: 'rgb(37, 99, 235)' },
      }).success,
    ).toBe(true);
    // styles is optional
    expect(
      ContentToSw.safeParse({ type: 'element-picked', candidates: [selector], rect }).success,
    ).toBe(true);
  });

  it('accepts multi-select-changed with a (possibly empty) list of selectors', () => {
    expect(
      ContentToSw.safeParse({ type: 'multi-select-changed', selectors: [selector, selector] })
        .success,
    ).toBe(true);
    expect(ContentToSw.safeParse({ type: 'multi-select-changed', selectors: [] }).success).toBe(
      true,
    );
  });

  it('accepts picker-state and recorder-event', () => {
    expect(ContentToSw.safeParse({ type: 'picker-state', active: true }).success).toBe(true);
    expect(
      ContentToSw.safeParse({
        type: 'recorder-event',
        event: { kind: 'setStyle', selector, before: 'a', after: 'b', ts: 2 },
      }).success,
    ).toBe(true);
  });

  it('rejects element-picked without a rect (malformed)', () => {
    expect(ContentToSw.safeParse({ type: 'element-picked', candidates: [selector] }).success).toBe(
      false,
    );
  });

  it('rejects picker-state with a non-boolean active (malformed)', () => {
    expect(ContentToSw.safeParse({ type: 'picker-state', active: 'yes' }).success).toBe(false);
  });

  it('rejects recorder-event wrapping a malformed MutationEvent', () => {
    expect(
      ContentToSw.safeParse({
        type: 'recorder-event',
        event: { kind: 'nope', selector, before: 'a', after: 'b', ts: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown ContentToSw type (malformed discriminant)', () => {
    expect(ContentToSw.safeParse({ type: 'element-hovered', candidates: [selector] }).success).toBe(
      false,
    );
  });

  it('rejects a ContentToSw message missing the discriminant', () => {
    expect(ContentToSw.safeParse({ candidates: [selector], rect }).success).toBe(false);
  });
});

describe('typed tool result payloads (ToolResult.data envelope stays unknown)', () => {
  it('parses QueryResult / GetStylesResult / A11yResult', () => {
    expect(QueryResult.safeParse({ matches: [selector] }).success).toBe(true);
    expect(
      GetStylesResult.safeParse({ styles: { color: 'rgb(0, 0, 0)', 'font-size': '16px' } }).success,
    ).toBe(true);
    expect(
      A11yResult.safeParse({ tree: { role: 'button', name: 'Buy', children: [] } }).success,
    ).toBe(true);
    // nested role/name tree
    expect(
      A11yResult.safeParse({
        tree: {
          role: 'navigation',
          name: 'Main',
          children: [{ role: 'link', name: 'Home', children: [] }],
        },
      }).success,
    ).toBe(true);
  });

  // Chrome's AX API and every ARIA serializer omit `children` on a leaf rather than
  // emitting an empty array. A required `children` would reject a well-formed snapshot.
  it('accepts an a11y leaf with no children key, defaulting it to an empty array', () => {
    const parsed = A11yResult.safeParse({ tree: { role: 'button', name: 'Buy' } });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.tree.children).toEqual([]);
  });

  it('rejects malformed tool result payloads', () => {
    expect(QueryResult.safeParse({ matches: 'nope' }).success).toBe(false);
    expect(GetStylesResult.safeParse({ styles: { color: 42 } }).success).toBe(false);
  });

  // Each required field pinned on its own. Omitting several at once cannot tell you
  // which one the schema actually enforces: a reject stays a reject even if one of
  // them silently regresses to optional.
  it('requires role and name independently on an a11y node', () => {
    expect(A11yResult.safeParse({ tree: { name: 'Buy', children: [] } }).success).toBe(false);
    expect(A11yResult.safeParse({ tree: { role: 'button', children: [] } }).success).toBe(false);
    expect(A11yResult.safeParse({ tree: { role: 'button', name: 'Buy' } }).success).toBe(true);
  });

  it('rejects a malformed node nested inside an otherwise valid a11y tree', () => {
    const parsed = A11yResult.safeParse({
      tree: { role: 'navigation', name: 'Main', children: [{ role: 'link' }] },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('SwToPanel (SW -> panel stream: relay of picker events)', () => {
  it('accepts focus with selector + rect', () => {
    expect(SwToPanel.safeParse({ type: 'focus', selector, rect }).success).toBe(true);
  });

  it('accepts picker-state active boolean', () => {
    expect(SwToPanel.safeParse({ type: 'picker-state', active: false }).success).toBe(true);
  });

  it('rejects focus missing rect (malformed)', () => {
    expect(SwToPanel.safeParse({ type: 'focus', selector }).success).toBe(false);
  });

  it('accepts picker-state with active true', () => {
    expect(SwToPanel.safeParse({ type: 'picker-state', active: true }).success).toBe(true);
  });

  it('rejects picker-state with non-boolean active', () => {
    expect(SwToPanel.safeParse({ type: 'picker-state', active: 'yes' }).success).toBe(false);
  });

  it('exposes focus and picker-state as SwToPanel discriminants', () => {
    const discs = SwToPanel.options.map((s) => s.shape.type.value);

    expect(discs).toContain('focus');
    expect(discs).toContain('picker-state');
  });

  it('accepts an mcp-status push carrying a full McpServer record', () => {
    const server = {
      id: 'ai-dev',
      label: 'ai-dev',
      url: 'https://ai-dev.example.com/mcp',
      transport: 'http' as const,
      authKind: 'apikey' as const,
      status: 'connected' as const,
      toolCount: 2,
      tools: ['create_task', 'get_task'],
    };
    expect(SwToPanel.safeParse({ type: 'mcp-status', server }).success).toBe(true);
    expect(McpServer.safeParse(server).success).toBe(true);
  });

  it('rejects an mcp-status push with a malformed server (bad url)', () => {
    expect(
      SwToPanel.safeParse({
        type: 'mcp-status',
        server: {
          id: 'x',
          label: 'X',
          url: 'not-a-url',
          transport: 'http',
          authKind: 'none',
          status: 'disconnected',
          toolCount: 0,
          tools: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe('MCP server RPCs (panel <-> service worker)', () => {
  it('accepts mcp-add with just label + url, transport/authKind optional', () => {
    const r = PanelToSw.safeParse({
      type: 'mcp-add',
      label: 'ai-dev',
      url: 'https://ai-dev.example.com/mcp',
    });
    expect(r.success).toBe(true);
  });

  it('accepts mcp-add with an explicit transport + authKind', () => {
    expect(
      PanelToSw.safeParse({
        type: 'mcp-add',
        label: 'GitHub MCP',
        url: 'https://github.example.com/mcp',
        transport: 'http',
        authKind: 'oauth',
      }).success,
    ).toBe(true);
  });

  it('rejects mcp-add missing a url or with an empty label', () => {
    expect(PanelToSw.safeParse({ type: 'mcp-add', label: 'x' }).success).toBe(false);
    expect(PanelToSw.safeParse({ type: 'mcp-add', label: '', url: 'https://x/mcp' }).success).toBe(
      false,
    );
  });

  it('accepts mcp-remove / mcp-list / mcp-connect / mcp-status', () => {
    expect(PanelToSw.safeParse({ type: 'mcp-remove', id: 's1' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'mcp-list' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'mcp-connect', id: 's1' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'mcp-status' }).success).toBe(true);
  });

  it('rejects mcp-remove / mcp-connect without an id', () => {
    expect(PanelToSw.safeParse({ type: 'mcp-remove' }).success).toBe(false);
    expect(PanelToSw.safeParse({ type: 'mcp-connect' }).success).toBe(false);
  });

  it('accepts mcp-auth-start (apikey variant)', () => {
    expect(
      PanelToSw.safeParse({
        type: 'mcp-auth-start',
        id: 's1',
        authKind: 'apikey',
        apiKey: 'admin-key-abc',
      }).success,
    ).toBe(true);
  });

  it('accepts mcp-auth-start (oauth variant)', () => {
    expect(
      PanelToSw.safeParse({
        type: 'mcp-auth-start',
        id: 's1',
        authKind: 'oauth',
        oauth: {
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'client-123',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects mcp-auth-start when the payload does not match its authKind', () => {
    // apikey without apiKey
    expect(
      PanelToSw.safeParse({ type: 'mcp-auth-start', id: 's1', authKind: 'apikey' }).success,
    ).toBe(false);
    // oauth without oauth config
    expect(
      PanelToSw.safeParse({ type: 'mcp-auth-start', id: 's1', authKind: 'oauth' }).success,
    ).toBe(false);
    // unknown authKind
    expect(
      PanelToSw.safeParse({ type: 'mcp-auth-start', id: 's1', authKind: 'none' }).success,
    ).toBe(false);
  });

  it('parses the McpServerResult / McpListResult RPC response shapes', () => {
    const server = {
      id: 's1',
      label: 'S1',
      url: 'https://s1.example.com/mcp',
      transport: 'http' as const,
      authKind: 'none' as const,
      status: 'disconnected' as const,
      toolCount: 0,
      tools: [],
    };
    expect(McpServerResult.safeParse({ ok: true, server }).success).toBe(true);
    expect(McpServerResult.safeParse({ ok: false, error: 'boom' }).success).toBe(true);
    expect(McpListResult.safeParse({ ok: true, servers: [server] }).success).toBe(true);
  });
});
