import { describe, expect, it } from 'vitest';
import { TurnChangeset } from '@/agent/turn-changeset';
import { ChangesetStore } from '@/changeset/store';
import { type Changeset, type ChangesetState, type Edit, emptyChangeset } from '@/shared/changeset';

// turn-changeset unit: the running turn's guarded write-back. The bug it pins: after the agent's
// own navigation the store kept the OLD document URL, so the persist guard refused every later
// write of the turn — recordEdit said ok, nothing was saved, Ship said "Nothing to ship".

const OLD = 'https://shop.example/';
const NEW = 'https://shop.example/checkout';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const anEdit: Edit = {
  intent: 'make the CTA pop',
  selector: { value: '#cta', strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: '#000', after: '#fff' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
};

function harness() {
  let committed = OLD;
  const saved: ChangesetState[] = [];
  const mirrored: Changeset[] = [];
  const turn = new TurnChangeset(
    new ChangesetStore(emptyChangeset(OLD, '2026-07-13T00:00:00Z', SESSION_ID)),
    {
      committedUrl: async () => committed,
      save: (state) => {
        saved.push(state);
      },
      mirror: async (cs) => {
        mirrored.push(cs);
      },
      now: () => '2026-07-14T00:00:00Z',
    },
  );
  return { turn, saved, mirrored, navigate: (url: string) => (committed = url) };
}

describe('TurnChangeset.persist', () => {
  it('writes both mirrors for the current document', async () => {
    const { turn, saved, mirrored } = harness();
    turn.store.record(anEdit);
    await turn.persist();
    expect(saved).toHaveLength(1);
    expect(mirrored[0]?.edits).toHaveLength(1);
  });

  it('refuses a store for a document the tab has left (a page/user navigation)', async () => {
    const { turn, saved, navigate } = harness();
    navigate(NEW);
    turn.store.record(anEdit);
    await turn.persist();
    expect(saved).toHaveLength(0);
  });
});

describe('TurnChangeset.rebase — the agent navigated', () => {
  it('moves the turn onto the new document: old edits dropped, later edits persist', async () => {
    const { turn, saved, mirrored, navigate } = harness();
    turn.store.record(anEdit); // recorded against the OLD document
    navigate(NEW);
    expect(turn.rebase(NEW)).toBe(true);
    expect(turn.store.current.url).toBe(NEW);
    expect(turn.store.current.edits).toHaveLength(0);
    expect(turn.store.current.sessionId).toBe(SESSION_ID); // history identity kept (#168 L6)

    turn.store.record(anEdit);
    await turn.persist();
    expect(saved.at(-1)?.changeset.url).toBe(NEW);
    expect(mirrored.at(-1)?.edits).toHaveLength(1);
  });

  it('is a no-op for the same URL (a reload keeps the record)', () => {
    const { turn } = harness();
    turn.store.record(anEdit);
    expect(turn.rebase(OLD)).toBe(false);
    expect(turn.store.current.edits).toHaveLength(1);
  });

  it('a persist already awaiting the URL writes the REBASED store, never the stale one', async () => {
    const { turn, saved, navigate } = harness();
    turn.store.record(anEdit);
    navigate(NEW);
    const inFlight = turn.persist();
    turn.rebase(NEW);
    await inFlight;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.changeset.url).toBe(NEW);
    expect(saved[0]?.changeset.edits).toHaveLength(0);
  });
});

describe('TurnChangeset.close — the tab was removed', () => {
  it('refuses every later write, and a rebase', async () => {
    const { turn, saved } = harness();
    turn.close();
    turn.store.record(anEdit);
    await turn.persist();
    expect(saved).toHaveLength(0);
    expect(turn.rebase(NEW)).toBe(false);
    expect(turn.isClosed).toBe(true);
  });

  it('a persist in flight when the tab closes writes nothing', async () => {
    const { turn, saved } = harness();
    turn.store.record(anEdit);
    const inFlight = turn.persist();
    turn.close();
    await inFlight;
    expect(saved).toHaveLength(0);
  });
});

describe('TurnChangeset.persist — a navigation during the save', () => {
  it('does not republish the old snapshot to the mirror nav-clear just reseeded', async () => {
    let committed = OLD;
    const mirrored: Changeset[] = [];
    const turn = new TurnChangeset(
      new ChangesetStore(emptyChangeset(OLD, '2026-07-13T00:00:00Z', SESSION_ID)),
      {
        committedUrl: async () => committed,
        save: async () => {
          committed = NEW; // the page committed a new document while the save was in flight
        },
        mirror: async (cs) => {
          mirrored.push(cs);
        },
      },
    );
    turn.store.record(anEdit);
    await turn.persist();
    expect(mirrored).toHaveLength(0);
  });
});
