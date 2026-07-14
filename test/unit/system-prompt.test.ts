import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  PROMPT_SECTION_NAMES,
  type PromptSectionName,
} from '@/agent/system-prompt';

// system-prompt.ts unit: the prompt is a pure, deterministic string built from named
// sections in a fixed order, with an `addenda` slot so modes (06) and later slices append
// without editing the base prose. We assert the sections are all present and ordered, the
// persona/doctrine/guardrails carry their load-bearing rules, and addenda land inside the
// right section rather than at the end.

const HEADINGS: Record<PromptSectionName, string> = {
  persona: '## Persona',
  doctrine: '## Operating doctrine',
  tools: '## Tool-use policy',
  modes: '## Modes',
  output: '## Output & report voice',
  guardrails: '## Guardrails',
};

describe('buildSystemPrompt: base composition', () => {
  it('leads with the developerz.ai Designer identity', () => {
    expect(buildSystemPrompt()).toContain('developerz.ai Designer');
  });

  it('renders every declared section exactly once', () => {
    const prompt = buildSystemPrompt();
    for (const name of PROMPT_SECTION_NAMES) {
      const heading = HEADINGS[name];
      const occurrences = prompt.split(heading).length - 1;
      expect(occurrences, `${heading} should appear once`).toBe(1);
    }
  });

  it('orders the sections persona → doctrine → tools → modes → output → guardrails', () => {
    const prompt = buildSystemPrompt();
    const positions = PROMPT_SECTION_NAMES.map((name) => prompt.indexOf(HEADINGS[name]));
    expect(positions.every((p) => p >= 0)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('is pure and deterministic — same options, same string', () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt({}));
    expect(buildSystemPrompt({ addenda: { modes: ['x'] } })).toBe(
      buildSystemPrompt({ addenda: { modes: ['x'] } }),
    );
  });
});

describe('buildSystemPrompt: load-bearing content', () => {
  const prompt = buildSystemPrompt();

  it('states the senior-developer + designer persona', () => {
    expect(prompt).toMatch(/senior web developer and product designer/i);
  });

  it('states the autonomy doctrine: one instruction → many steps, do the work', () => {
    expect(prompt).toMatch(/one user instruction kicks off a full multi-step run/i);
    expect(prompt).toContain('Do the work.');
    expect(prompt).toMatch(/ask only when genuinely ambiguous/i);
  });

  it('encodes the guardrails: never auto-ship, budget, fragile selectors, ephemeral', () => {
    expect(prompt).toMatch(/never ship on your own/i);
    expect(prompt).toMatch(/handoff` is user-triggered and approval-gated/i);
    expect(prompt).toMatch(/respect the budget/i);
    expect(prompt).toMatch(/flag fragile selectors/i);
    expect(prompt).toMatch(/edits are ephemeral/i);
  });

  it('states the tool-use cost policy (vision spent deliberately, read before write)', () => {
    expect(prompt).toMatch(/read before you write/i);
    expect(prompt).toMatch(/spend vision deliberately/i);
  });

  it('frames both copy and debug behaviors for the modes slot', () => {
    expect(prompt).toMatch(/Copy \/ design/i);
    expect(prompt).toMatch(/Debug/);
  });
});

describe('buildSystemPrompt: addenda injection (modes-ready)', () => {
  const ADDENDUM = 'MODE_ADDENDUM_COPY_SITE_SENTINEL';

  it('injects a mode addendum inside the modes section, before the next section', () => {
    const prompt = buildSystemPrompt({ addenda: { modes: [ADDENDUM] } });
    const at = prompt.indexOf(ADDENDUM);
    expect(at).toBeGreaterThan(prompt.indexOf(HEADINGS.modes));
    expect(at).toBeLessThan(prompt.indexOf(HEADINGS.output));
  });

  it('appends multiple addenda in order', () => {
    const prompt = buildSystemPrompt({ addenda: { modes: ['FIRST_ADDENDUM', 'SECOND_ADDENDUM'] } });
    expect(prompt.indexOf('FIRST_ADDENDUM')).toBeLessThan(prompt.indexOf('SECOND_ADDENDUM'));
  });

  it('ignores empty and whitespace-only addenda', () => {
    expect(buildSystemPrompt({ addenda: { modes: ['', '   ', '\n'] } })).toBe(buildSystemPrompt());
  });

  it('extends any named section, not just modes', () => {
    const prompt = buildSystemPrompt({ addenda: { guardrails: ['EXTRA_GUARDRAIL_SENTINEL'] } });
    const at = prompt.indexOf('EXTRA_GUARDRAIL_SENTINEL');
    expect(at).toBeGreaterThan(prompt.indexOf(HEADINGS.guardrails));
  });

  it('leaves the base prompt untouched when no addenda are given', () => {
    expect(buildSystemPrompt({ addenda: {} })).toBe(buildSystemPrompt());
  });
});
