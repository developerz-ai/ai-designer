import { describe, expect, it } from 'vitest';
import {
  A11yResult,
  A11ySnapshotInput,
  CaptureRequest,
  CaptureResult,
  CheckResponsiveInput,
  CheckResponsiveResult,
  ContentToSw,
  ControlTool,
  Conversation,
  ConversationSummary,
  DomTool,
  FrameInfo,
  FramesInput,
  FramesResult,
  GetProviderResult,
  GetStylesInput,
  GetStylesResult,
  HISTORY_MAX_MESSAGES,
  HISTORY_MAX_REPORT_CHARS,
  HISTORY_MAX_TITLE_CHARS,
  HistoryDelete,
  HistoryGet,
  HistoryGetResult,
  HistoryList,
  HistoryListResult,
  ImageInfo,
  InspectVisuallyInput,
  InspectVisuallyResult,
  KeyStatusResult,
  McpListResult,
  McpServer,
  McpServerResult,
  ModelsResult,
  MutationEvent,
  NavIntent,
  NavResult,
  PanelToSw,
  PickerCmd,
  ProviderConfig,
  QueryInput,
  QueryResult,
  ReadImagesResult,
  ResponsiveCaptureInput,
  ResponsiveFinding,
  SaveKeyResult,
  SaveProviderResult,
  ScreenshotInput,
  SetDeviceInput,
  SetDeviceResult,
  SetStyleInput,
  SetTextInput,
  SwToPanel,
  TabInfo,
  TabsCmd,
  TabsResult,
  Target,
  ToolResult,
  UndoInput,
  WaitCondition,
  WaitForInput,
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

describe('responsive / device-emulation schemas (slice 16)', () => {
  it('accepts a preset setDevice and a custom one', () => {
    expect(SetDeviceInput.safeParse({ type: 'setDevice', preset: 'iphone-15' }).success).toBe(true);
    expect(
      SetDeviceInput.safeParse({ type: 'setDevice', width: 400, height: 800, touch: true }).success,
    ).toBe(true);
    expect(SetDeviceInput.safeParse({ type: 'setDevice', reset: true }).success).toBe(true);
  });

  it('rejects an unknown preset and an over-large dimension', () => {
    expect(SetDeviceInput.safeParse({ type: 'setDevice', preset: 'nokia' }).success).toBe(false);
    expect(SetDeviceInput.safeParse({ type: 'setDevice', width: 99999, height: 800 }).success).toBe(
      false,
    );
  });

  it('parses a setDevice result (metrics optional for reset)', () => {
    expect(
      SetDeviceResult.safeParse({ label: 'Reset', mechanism: 'reset', banner: false }).success,
    ).toBe(true);
    expect(
      SetDeviceResult.safeParse({
        label: 'iPhone 15',
        mechanism: 'cdp',
        banner: true,
        metrics: { width: 393, height: 852, dpr: 3, touch: true, mobile: true },
      }).success,
    ).toBe(true);
  });

  it('accepts responsiveCapture with breakpoints and defaults', () => {
    expect(ResponsiveCaptureInput.safeParse({ type: 'responsiveCapture' }).success).toBe(true);
    expect(
      ResponsiveCaptureInput.safeParse({
        type: 'responsiveCapture',
        breakpoints: [{ preset: 'ipad-mini' }, { label: 'wide', width: 1440, height: 900 }],
        fullPage: true,
      }).success,
    ).toBe(true);
  });

  it('parses checkResponsive + its findings payload', () => {
    expect(
      CheckResponsiveInput.safeParse({ type: 'checkResponsive', selector: '#main' }).success,
    ).toBe(true);
    const r = CheckResponsiveResult.safeParse({
      viewportWidth: 375,
      findings: [
        { category: 'overflow', severity: 'serious', detail: 'scrolls sideways', selector },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a ResponsiveFinding with an unknown category or severity', () => {
    const base = { detail: 'scrolls sideways', selector };
    expect(
      ResponsiveFinding.safeParse({ ...base, category: 'bogus', severity: 'serious' }).success,
    ).toBe(false);
    expect(
      ResponsiveFinding.safeParse({ ...base, category: 'overflow', severity: 'catastrophic' })
        .success,
    ).toBe(false);
  });

  it('rejects a ResponsiveFinding missing its selector', () => {
    expect(
      ResponsiveFinding.safeParse({
        category: 'tap-target',
        severity: 'moderate',
        detail: 'too small',
      }).success,
    ).toBe(false);
  });

  it('rejects a CheckResponsiveResult with a negative viewport width or an oversized findings list', () => {
    expect(CheckResponsiveResult.safeParse({ viewportWidth: -1, findings: [] }).success).toBe(
      false,
    );
    const tooMany = Array.from({ length: 81 }, () => ({
      category: 'overflow' as const,
      severity: 'minor' as const,
      detail: 'x',
      selector,
    }));
    expect(CheckResponsiveResult.safeParse({ viewportWidth: 375, findings: tooMany }).success).toBe(
      false,
    );
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

describe('CaptureRequest / CaptureResult (content <-> SW screenshot round-trip)', () => {
  it('accepts a capture request with a rect and a positive devicePixelRatio', () => {
    expect(
      CaptureRequest.safeParse({ type: 'capture-visible-tab', rect, devicePixelRatio: 2 }).success,
    ).toBe(true);
  });

  it('rejects a non-positive devicePixelRatio', () => {
    expect(
      CaptureRequest.safeParse({ type: 'capture-visible-tab', rect, devicePixelRatio: 0 }).success,
    ).toBe(false);
  });

  it('accepts both an ok result with a data URL and an error result', () => {
    expect(
      CaptureResult.safeParse({ ok: true, dataUrl: 'data:image/png;base64,AAAA' }).success,
    ).toBe(true);
    expect(CaptureResult.safeParse({ ok: false, error: 'capture failed' }).success).toBe(true);
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

  it('does not carry multi-select / recorder-event — no panel store consumes them', () => {
    const discs = SwToPanel.options.map((s) => s.shape.type.value);
    expect(discs).not.toContain('multi-select');
    expect(discs).not.toContain('recorder-event');
    expect(SwToPanel.safeParse({ type: 'multi-select', selectors: [selector] }).success).toBe(
      false,
    );
    expect(
      SwToPanel.safeParse({
        type: 'recorder-event',
        event: { kind: 'setStyle', selector, before: '', after: 'x', ts: 1 },
      }).success,
    ).toBe(false);
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

describe('shared Target on DOM tools (slice 13 iframes / multi-tab)', () => {
  it('accepts a DomTool carrying tabId + frameId', () => {
    expect(
      DomTool.safeParse({ type: 'query', selector: '#hero', tabId: 3, frameId: 7 }).success,
    ).toBe(true);
    expect(
      DomTool.safeParse({ type: 'setStyle', selector: '#x', props: { color: 'red' }, tabId: 0 })
        .success,
    ).toBe(true);
  });

  it('keeps tabId/frameId optional — a pre-frames call still validates unchanged', () => {
    expect(DomTool.safeParse({ type: 'query', selector: '#hero' }).success).toBe(true);
    expect(Target.safeParse({}).success).toBe(true);
    expect(Target.safeParse({ tabId: 2, frameId: 0 }).success).toBe(true);
  });

  it('rejects a negative or non-integer tabId/frameId', () => {
    expect(DomTool.safeParse({ type: 'query', selector: '#h', frameId: -1 }).success).toBe(false);
    expect(DomTool.safeParse({ type: 'query', selector: '#h', tabId: 1.5 }).success).toBe(false);
  });

  it('adds an optional fullPage flag to screenshot', () => {
    expect(ScreenshotInput.safeParse({ type: 'screenshot', fullPage: true }).success).toBe(true);
    expect(ScreenshotInput.safeParse({ type: 'screenshot', fullPage: 'yes' }).success).toBe(false);
  });
});

describe('ControlTool (slice 13 content-routed driving tools)', () => {
  it('accepts click / hover with a selector + Target', () => {
    expect(ControlTool.safeParse({ type: 'click', selector: '#buy', frameId: 2 }).success).toBe(
      true,
    );
    expect(ControlTool.safeParse({ type: 'hover', selector: 'nav' }).success).toBe(true);
  });

  it('accepts type with text and an optional submit flag', () => {
    expect(ControlTool.safeParse({ type: 'type', selector: 'input', text: 'hi' }).success).toBe(
      true,
    );
    expect(
      ControlTool.safeParse({ type: 'type', selector: 'input', text: 'hi', submit: true }).success,
    ).toBe(true);
  });

  it('accepts pressKey / scrollTo (selector or y) / selectOption', () => {
    expect(ControlTool.safeParse({ type: 'pressKey', key: 'Enter' }).success).toBe(true);
    expect(ControlTool.safeParse({ type: 'scrollTo', y: 800 }).success).toBe(true);
    expect(ControlTool.safeParse({ type: 'scrollTo', selector: '#footer' }).success).toBe(true);
    expect(
      ControlTool.safeParse({ type: 'selectOption', selector: 'select', value: 'us' }).success,
    ).toBe(true);
  });

  it('rejects pressKey with an empty key and click without a selector', () => {
    expect(ControlTool.safeParse({ type: 'pressKey', key: '' }).success).toBe(false);
    expect(ControlTool.safeParse({ type: 'click' }).success).toBe(false);
  });

  it('accepts handleDialog and readImages', () => {
    expect(ControlTool.safeParse({ type: 'handleDialog', accept: true }).success).toBe(true);
    expect(
      ControlTool.safeParse({ type: 'handleDialog', accept: false, promptText: 'ok' }).success,
    ).toBe(true);
    expect(ControlTool.safeParse({ type: 'readImages' }).success).toBe(true);
    expect(ControlTool.safeParse({ type: 'readImages', selector: '.gallery' }).success).toBe(true);
  });

  it('does not overlap DomTool — the two unions share no discriminant', () => {
    expect(DomTool.safeParse({ type: 'click', selector: '#x' }).success).toBe(false);
    expect(ControlTool.safeParse({ type: 'query', selector: '#x' }).success).toBe(false);
  });
});

describe('waitFor is bounded (slice 13 guardrail)', () => {
  it('accepts each condition and a plain timed wait', () => {
    expect(WaitForInput.safeParse({ type: 'waitFor', selector: '#loaded' }).success).toBe(true);
    expect(WaitForInput.safeParse({ type: 'waitFor', text: 'Done' }).success).toBe(true);
    expect(WaitForInput.safeParse({ type: 'waitFor', networkIdle: true }).success).toBe(true);
    expect(WaitForInput.safeParse({ type: 'waitFor', timeMs: 500 }).success).toBe(true);
    expect(WaitCondition.safeParse({ selector: '#x', timeMs: 2000 }).success).toBe(true);
  });

  it('caps the wait at 30s and rejects a non-positive time', () => {
    expect(WaitForInput.safeParse({ type: 'waitFor', timeMs: 30_001 }).success).toBe(false);
    expect(WaitForInput.safeParse({ type: 'waitFor', timeMs: 0 }).success).toBe(false);
  });
});

describe('ImageInfo / ReadImagesResult (slice 13 vision signal)', () => {
  const img = {
    selector,
    kind: 'img' as const,
    src: 'https://cdn.example.com/hero.png',
    alt: 'Hero',
    naturalWidth: 2000,
    naturalHeight: 1000,
    renderedWidth: 400,
    renderedHeight: 200,
    broken: false,
    oversized: true,
  };

  it('accepts a well-formed image (alt optional, background kind)', () => {
    expect(ImageInfo.safeParse(img).success).toBe(true);
    expect(ImageInfo.safeParse({ ...img, kind: 'background', alt: undefined }).success).toBe(true);
  });

  it('rejects an unknown kind and a non-StableSelector target', () => {
    expect(ImageInfo.safeParse({ ...img, kind: 'svg' }).success).toBe(false);
    expect(ImageInfo.safeParse({ ...img, selector: '#x' }).success).toBe(false);
  });

  it('bounds the enumerated image list (defense-in-depth)', () => {
    expect(ReadImagesResult.safeParse({ images: [img] }).success).toBe(true);
    expect(
      ReadImagesResult.safeParse({ images: Array.from({ length: 201 }, () => img) }).success,
    ).toBe(false);
  });
});

describe('SW-orchestrated control tools (navigation / tabs / frames / vision)', () => {
  it('navigate requires a url; navigateBack / reload take none', () => {
    expect(NavIntent.safeParse({ type: 'navigate', url: 'https://x.dev/' }).success).toBe(true);
    expect(NavIntent.safeParse({ type: 'navigate' }).success).toBe(false);
    expect(NavIntent.safeParse({ type: 'navigate', url: 'not-a-url' }).success).toBe(false);
    expect(NavIntent.safeParse({ type: 'navigateBack' }).success).toBe(true);
    expect(NavIntent.safeParse({ type: 'reload', tabId: 4 }).success).toBe(true);
    expect(NavResult.safeParse({ url: 'https://x.dev/', title: 'X' }).success).toBe(true);
  });

  it('tabs accepts every action; open carries a url, close/activate a tabId', () => {
    expect(TabsCmd.safeParse({ type: 'tabs', action: 'list' }).success).toBe(true);
    expect(TabsCmd.safeParse({ type: 'tabs', action: 'open', url: 'https://x.dev/' }).success).toBe(
      true,
    );
    expect(TabsCmd.safeParse({ type: 'tabs', action: 'close', tabId: 9 }).success).toBe(true);
    expect(TabsCmd.safeParse({ type: 'tabs', action: 'teleport' }).success).toBe(false);
    const tab = { tabId: 1, url: 'https://x.dev/', title: 'X', active: true };
    expect(TabInfo.safeParse(tab).success).toBe(true);
    expect(TabsResult.safeParse({ tabs: [tab] }).success).toBe(true);
  });

  it('frames lists a tab; FrameInfo carries frameId / origin / isMain', () => {
    expect(FramesInput.safeParse({ type: 'frames', action: 'list', tabId: 1 }).success).toBe(true);
    expect(FramesInput.safeParse({ type: 'frames', action: 'walk' }).success).toBe(false);
    expect(
      FrameInfo.safeParse({
        frameId: 0,
        url: 'https://x.dev/',
        origin: 'https://x.dev',
        isMain: true,
      }).success,
    ).toBe(true);
    expect(FramesResult.safeParse({ frames: [] }).success).toBe(true);
  });

  it('inspectVisually needs a question and returns a verdict', () => {
    expect(
      InspectVisuallyInput.safeParse({ type: 'inspectVisually', question: 'Does the CTA pop?' })
        .success,
    ).toBe(true);
    expect(
      InspectVisuallyInput.safeParse({
        type: 'inspectVisually',
        selector: '#cta',
        fullPage: false,
        question: 'q',
        frameId: 1,
      }).success,
    ).toBe(true);
    expect(InspectVisuallyInput.safeParse({ type: 'inspectVisually' }).success).toBe(false);
    expect(
      InspectVisuallyResult.safeParse({ verdict: 'Yes, sufficient contrast.', pass: true }).success,
    ).toBe(true);
  });

  it('keeps the SW-orchestrated tools out of DomTool and ControlTool', () => {
    for (const t of ['navigate', 'tabs', 'frames', 'inspectVisually']) {
      expect(DomTool.safeParse({ type: t }).success).toBe(false);
      expect(ControlTool.safeParse({ type: t }).success).toBe(false);
    }
  });
});

describe('ToolResult frame tagging (slice 13)', () => {
  it('accepts an optional frameId on the result envelope', () => {
    expect(ToolResult.safeParse({ type: 'tool-result', ok: true, frameId: 5 }).success).toBe(true);
    expect(ToolResult.safeParse({ type: 'tool-result', ok: true }).success).toBe(true);
  });

  it('rejects a negative frameId', () => {
    expect(ToolResult.safeParse({ type: 'tool-result', ok: true, frameId: -2 }).success).toBe(
      false,
    );
  });
});

// History (slice 08): `Conversation`/`ConversationSummary` + the history-* RPCs on the bus. The
// bounds asserted here mirror `history-store.ts`'s write-time `boundMessages`/title/report slices —
// a corrupt or hand-crafted oversized record must fail `hydrate()`'s re-validation, not just the
// writer's own bounding.
describe('Conversation / history schemas (slice 08)', () => {
  const base = {
    id: 'sess-1',
    title: 'Redesign hero',
    url: 'https://example.com/pricing',
    mode: 'copy' as const,
    createdAt: 1_700_000_000_000,
    messages: [{ role: 'user' as const, content: 'redesign the hero' }],
  };

  it('accepts a minimal conversation (mode/report/prLink all optional)', () => {
    const r = Conversation.safeParse({
      id: 'a',
      title: 't',
      url: 'https://example.com',
      createdAt: 0,
      messages: [],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a full conversation with a report + PR link', () => {
    const r = Conversation.safeParse({ ...base, report: '# Report', prLink: 'https://gh/p/1' });
    expect(r.success).toBe(true);
  });

  it('rejects a title over HISTORY_MAX_TITLE_CHARS', () => {
    const r = Conversation.safeParse({ ...base, title: 'x'.repeat(HISTORY_MAX_TITLE_CHARS + 1) });
    expect(r.success).toBe(false);
  });

  it('rejects a report over HISTORY_MAX_REPORT_CHARS', () => {
    const r = Conversation.safeParse({
      ...base,
      report: 'x'.repeat(HISTORY_MAX_REPORT_CHARS + 1),
    });
    expect(r.success).toBe(false);
  });

  it('rejects more than HISTORY_MAX_MESSAGES messages', () => {
    const messages = Array.from({ length: HISTORY_MAX_MESSAGES + 1 }, () => ({
      role: 'user' as const,
      content: 'x',
    }));
    const r = Conversation.safeParse({ ...base, messages });
    expect(r.success).toBe(false);
  });

  it('rejects a message that fails modelMessageSchema (unknown role)', () => {
    const r = Conversation.safeParse({ ...base, messages: [{ role: 'narrator', content: 'x' }] });
    expect(r.success).toBe(false);
  });

  it('ConversationSummary drops messages/report in favor of counts', () => {
    const r = ConversationSummary.safeParse({
      id: 'a',
      title: 't',
      url: 'https://example.com',
      createdAt: 0,
      messageCount: 3,
      hasReport: true,
    });
    expect(r.success).toBe(true);
    // The heavy fields aren't part of the shape at all.
    expect(
      ConversationSummary.safeParse({ ...base, messageCount: 1, hasReport: false }).data,
    ).not.toHaveProperty('messages');
  });

  it('history-list/get/delete parse as PanelToSw RPCs', () => {
    expect(PanelToSw.safeParse({ type: 'history-list' }).success).toBe(true);
    expect(HistoryList.safeParse({ type: 'history-list' }).success).toBe(true);
    expect(PanelToSw.safeParse({ type: 'history-get', id: 'a' }).success).toBe(true);
    expect(HistoryGet.safeParse({ type: 'history-get' }).success).toBe(false); // id required
    expect(PanelToSw.safeParse({ type: 'history-delete', id: 'a' }).success).toBe(true);
    expect(HistoryDelete.safeParse({ type: 'history-delete', id: '' }).success).toBe(false); // min(1)
  });

  it('HistoryListResult/HistoryGetResult accept the SW replies', () => {
    expect(
      HistoryListResult.safeParse({
        ok: true,
        conversations: [{ ...base, messageCount: 1, hasReport: false }],
      }).success,
    ).toBe(true);
    expect(HistoryGetResult.safeParse({ ok: true, conversation: base }).success).toBe(true);
    expect(HistoryGetResult.safeParse({ ok: false, error: 'No conversation a' }).success).toBe(
      true,
    );
  });
});
