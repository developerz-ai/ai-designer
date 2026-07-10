import { describe, expect, it } from 'vitest';
import {
  A11yResult,
  A11ySnapshotInput,
  ContentToSw,
  DomTool,
  GetStylesInput,
  GetStylesResult,
  KeyStatusResult,
  ModelsResult,
  MutationEvent,
  PanelToSw,
  PickerCmd,
  QueryInput,
  QueryResult,
  SaveKeyResult,
  ScreenshotInput,
  SetStyleInput,
  SetTextInput,
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

  it('rejects malformed tool result payloads', () => {
    expect(QueryResult.safeParse({ matches: 'nope' }).success).toBe(false);
    expect(GetStylesResult.safeParse({ styles: { color: 42 } }).success).toBe(false);
    expect(A11yResult.safeParse({ tree: { role: 'button' } }).success).toBe(false);
  });
});
