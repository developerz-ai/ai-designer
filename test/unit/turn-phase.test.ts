import { describe, expect, it } from 'vitest';
import {
  PHASE_KEY,
  type PhaseCall,
  turnPhase,
  workingPhaseKey,
} from '@/entrypoints/sidepanel/components/chat/turn-phase';
import { EDIT_OPS } from '@/shared/overlay-step';

// The working line's derivation, tested as the pure function it is (mirrors tool-chip.test.ts).
// The bug it fixes was a HONESTY bug — one hardcoded "Editing the page…" shown while the agent was
// reading — so the assertions below are mostly about what the phase must NEVER be, not just what it
// is: no read, no capture and no unrecognised call may ever report an edit.

const call = (tool: string, kind?: PhaseCall['kind']): PhaseCall => ({
  tool,
  ...(kind && { kind }),
});

describe('turnPhase', () => {
  it('reports "starting" before any tool has been called — the first-message gap', () => {
    expect(turnPhase([])).toBe('starting');
  });

  it('reports "starting" when the turn has no tool-call list at all', () => {
    expect(turnPhase(undefined)).toBe('starting');
  });

  it.each([
    'query',
    'getStyles',
    'a11ySnapshot',
    'describe',
    'pageFacts',
    'diagnostics',
    'readChart',
    'checkResponsive',
    'browse',
    'extractIdentity',
  ])('reports "reading" for the read op %s', (tool) => {
    expect(turnPhase([call(tool)])).toBe('reading');
  });

  it.each([
    'screenshot',
    'responsiveCapture',
    'inspectVisually',
    'readImages',
    'readImageContent',
  ])('reports "looking" for the vision op %s — a distinct, slow, visible thing', (tool) => {
    expect(turnPhase([call(tool)])).toBe('looking');
  });

  it.each([
    'setStyle',
    'setText',
    'setAttr',
    'removeAttr',
    'addClass',
    'removeClass',
    'batch',
    'insertNode',
    'moveNode',
    'removeNode',
    'wrapNode',
    'unwrapNode',
    'replaceNode',
    'injectCss',
  ])('reports "editing" for the mutation %s', (tool) => {
    expect(turnPhase([call(tool)])).toBe('editing');
  });

  it('reports "shipping" for the handoff', () => {
    expect(turnPhase([call('handoff')])).toBe('shipping');
  });

  // The GROUPED surface (src/agent/tools/resources.ts): a call that carries no `op` of its own
  // reaches the panel as the RESOURCE name, so both shapes have to classify. Handling only the
  // per-verb names left every resource-shaped call unclassified.
  it('classifies the grouped resource names, not just the per-verb ones', () => {
    expect(turnPhase([call('inspect')])).toBe('reading');
    expect(turnPhase([call('edit')])).toBe('editing');
  });

  it('lets the LATEST call decide — that is what is happening now', () => {
    const calls = [call('pageFacts'), call('screenshot'), call('setStyle')];
    expect(turnPhase(calls)).toBe('editing');
    expect(turnPhase(calls.slice(0, 2))).toBe('looking');
    expect(turnPhase(calls.slice(0, 1))).toBe('reading');
  });

  it('falls back to the SW-classified kind for a name it does not know', () => {
    expect(turnPhase([call('someMcpRead', 'read')])).toBe('reading');
    expect(turnPhase([call('click', 'act')])).toBe('editing');
    expect(turnPhase([call('tabs', 'info')])).toBe('thinking');
  });

  it('reports the generic phase for a call it knows nothing about', () => {
    expect(turnPhase([call('brand_new_tool')])).toBe('working');
  });

  it('never claims an edit for a read, a capture or an unknown call', () => {
    const nonEdits: PhaseCall[] = [
      call('pageFacts'),
      call('inspect'),
      call('screenshot'),
      call('someMcpRead', 'read'),
      call('brand_new_tool'),
      call('tabs', 'info'),
    ];
    for (const c of nonEdits) {
      expect(turnPhase([c])).not.toBe('editing');
    }
  });
});

describe('workingPhaseKey', () => {
  it('maps the empty turn onto the "getting started" line, never onto an edit claim', () => {
    expect(workingPhaseKey([])).toBe('message.phase.starting');
  });

  it('maps each phase onto its own i18n line', () => {
    expect(workingPhaseKey([{ tool: 'describe' }])).toBe('message.phase.reading');
    expect(workingPhaseKey([{ tool: 'screenshot' }])).toBe('message.phase.looking');
    expect(workingPhaseKey([{ tool: 'injectCss' }])).toBe('message.phase.editing');
    expect(workingPhaseKey([{ tool: 'handoff' }])).toBe('message.phase.shipping');
    expect(workingPhaseKey([{ tool: 'waitFor', kind: 'info' }])).toBe('message.phase.thinking');
  });

  it('keeps the pre-existing generic line as the last resort', () => {
    expect(workingPhaseKey([{ tool: '???' }])).toBe('message.working');
  });

  it('has a distinct key per phase — a duplicate would silently merge two phases', () => {
    const keys = Object.values(PHASE_KEY);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('classifies every shared EDIT_OPS member as editing — the sets must not drift', () => {
    for (const op of EDIT_OPS) {
      expect(workingPhaseKey([{ tool: op }])).toBe('message.phase.editing');
    }
  });
});
