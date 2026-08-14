import { beforeEach, describe, expect, it } from 'vitest';
import { foldMutationEvents } from '@/changeset/fold-mutations';
import { createDomExecutor } from '@/dom/execute';
import { createMutator } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import type { Edit } from '@/shared/changeset';
import type { ContentToSw, MutationEvent } from '@/shared/messages';

// Intent, from the mutation tool call to the changeset entry.
//
// This file started as a PIN on a defect. A real session on news.ycombinator.com produced ~15
// changeset entries, every one reading "Auto-recorded agent edit (no recordEdit call)" — the
// service worker's turn-end fallback. The fallback was never the bug: it is a deliberate safety net
// that guarantees a mutation the model forgot to narrate still reaches the durable changeset, and
// `recordEdit` was never meant to be called by the mutation tools.
//
// The bug was that INTENT HAD NO PATH. `setStyle`/`setText`/`insertNode` carried a selector and a
// value and nothing else; the recorder stamped a selector, a timestamp and the mechanical delta.
// Intent entered the record through exactly one door — a separate `recordEdit` call — so an edit
// the model did not separately narrate was intentless BY CONSTRUCTION.
//
// The path now exists (`Intent` on every mutation input and on `MutationEvent`). These assert it is
// actually wired end to end, which is the part a schema addition alone does not give you.

describe('intent survives from a mutation tool call to its changeset entry', () => {
  let emitted: MutationEvent[];

  function harness() {
    emitted = [];
    const emit = (msg: ContentToSw): void => {
      if (msg.type === 'recorder-event') emitted.push(msg.event);
    };
    const mutator = createMutator(document);
    const recorder = createRecorder(emit, () => 1_000);
    return createDomExecutor({ mutator, recorder, doc: document });
  }

  beforeEach(() => {
    document.body.innerHTML = '<main id="content"><p class="lead">Hello</p></main>';
  });

  it('stamps the tool call reason onto the recorder event', () => {
    const exec = harness();
    const result = exec.exec({
      type: 'setStyle',
      selector: '#content',
      props: { color: 'rgb(20, 20, 20)' },
      intent: 'Calm the body text to a softer near-black',
    });

    expect(result.ok).toBe(true);
    expect(emitted[0]?.intent).toBe('Calm the body text to a softer near-black');
    // The mechanical delta is unchanged — intent rides ALONGSIDE ground truth, never instead of it.
    expect(emitted[0]?.styleChanges?.[0]?.prop).toBe('color');
  });

  it('carries it through the fold into the durable Edit, replacing the placeholder', () => {
    const exec = harness();
    exec.exec({
      type: 'setStyle',
      selector: '#content',
      props: { color: 'rgb(20, 20, 20)' },
      intent: 'Calm the body text',
    });

    // Exactly what the SW's turn-end auto-finalize does with an undrained group: seed a blank Edit
    // with the placeholder and fold the real events onto it. The placeholder must lose.
    const seed: Edit = {
      intent: 'Auto-recorded agent edit (no recordEdit call)',
      selector: emitted[0]?.selector ?? { value: '#content', strategy: 'id', fragile: false },
      changes: [],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    const { folded } = foldMutationEvents(seed, emitted);
    expect(folded.intent).toBe('Calm the body text');
  });

  it('lets two mutations on DIFFERENT elements be recognised as one goal', () => {
    // The grouping half of the defect. The recorder groups by selector, so a goal spanning two
    // elements used to become two intentless entries with nothing tying them together. A shared
    // intent string is what makes them recognisable as one piece of work.
    const exec = harness();
    const intent = 'Centre the content column and calm the type';
    exec.exec({ type: 'setStyle', selector: '#content', props: { color: 'rgb(1, 1, 1)' }, intent });
    exec.exec({ type: 'setStyle', selector: '.lead', props: { color: 'rgb(2, 2, 2)' }, intent });

    expect(emitted.map((e) => e.selector.value)).toEqual(['#content', 'p.lead']);
    expect(new Set(emitted.map((e) => e.intent))).toEqual(new Set([intent]));
  });

  it('carries intent on every mutation family, not just setStyle', () => {
    const exec = harness();
    exec.exec({ type: 'setText', selector: '.lead', value: 'Hi', intent: 'shorten the greeting' });
    exec.exec({ type: 'addClass', selector: '.lead', name: 'muted', intent: 'de-emphasise it' });
    exec.exec({
      type: 'setAttr',
      selector: '.lead',
      name: 'lang',
      value: 'en',
      intent: 'label it',
    });
    exec.exec({ type: 'removeAttr', selector: '.lead', name: 'lang', intent: 'drop the label' });
    exec.exec({
      type: 'insertNode',
      selector: '#content',
      html: '<hr>',
      position: 'beforeend',
      intent: 'separate the sections',
    });

    expect(emitted.map((e) => e.intent)).toEqual([
      'shorten the greeting',
      'de-emphasise it',
      'label it',
      'drop the label',
      'separate the sections',
    ]);
  });

  it('stays absent rather than empty when the caller supplied none', () => {
    // Back-compat: the bus keeps `intent` optional, and an absent field must be genuinely absent
    // (not an explicit undefined) so the SW's fold can tell "no intent" from "empty intent".
    const exec = harness();
    exec.exec({ type: 'setStyle', selector: '#content', props: { color: 'rgb(3, 3, 3)' } });
    expect('intent' in (emitted[0] ?? {})).toBe(false);
  });
});
