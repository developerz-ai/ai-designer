import { describe, expect, it } from 'vitest';
import { errorText } from '@/agent/loop';

// What the panel SAYS when a turn fails. The raw provider string is usually the most useful thing
// available, so it is forwarded — except for the classes where it sends the reader somewhere useless.
// Each re-wording keeps the provider's own text in parentheses, because that is what belongs in a bug
// report even when it means nothing to the person reading the bubble.

describe('errorText', () => {
  it('forwards an ordinary provider message unchanged', () => {
    expect(errorText(new Error('upstream timed out'))).toBe('upstream timed out');
  });

  it('names an auth failure as a KEY problem, not an extension bug', () => {
    const err = Object.assign(new Error('No auth credentials found'), { statusCode: 401 });
    const text = errorText(err);
    expect(text).toContain('API key in Settings');
    expect(text).toContain('No auth credentials found');
  });

  describe('a rejected TOOL SCHEMA is our bug, and says so', () => {
    // Nothing in Settings fixes this, so a message that only forwards the provider's phrasing leaves
    // the user auditing a config that was never wrong. Both of these shipped and broke every turn.
    it.each([
      'tools.function.parameters.type is required and must be "object"',
      "tools.function.parameters is not a valid moonshot flavored json schema, details: <At path 'root': when using anyOf, type should be defined in anyOf items instead of the parent schema>",
      'Invalid schema for function inspect: expected an object',
    ])('recognises %s', (message) => {
      const text = errorText(new Error(message));
      expect(text).toMatch(/bug in Designer/i);
      // It points at the log that carries the detail — the report has to reach us to be actionable.
      expect(text).toMatch(/debug log/i);
      expect(text).toContain(message);
    });
  });

  it('tells the user to change MODEL when the model cannot call tools', () => {
    // Not our bug, and a different fix from the one above: plenty of models simply cannot do this.
    const text = errorText(new Error('This model does not support tools'));
    expect(text).toMatch(/pick a different model/i);
    expect(text).not.toMatch(/bug in Designer/i);
  });

  it('does NOT mislabel a model complaining about a tool ARGUMENT as a schema bug', () => {
    // The detector is narrow on purpose: "schema" appearing anywhere must not be enough, or an
    // ordinary bad-argument message would tell the user to file a bug against the extension.
    const text = errorText(new Error('the value you passed for selector was empty'));
    expect(text).not.toMatch(/bug in Designer/i);
    expect(text).toBe('the value you passed for selector was empty');
  });

  it('handles a non-Error throw', () => {
    expect(errorText('plain string failure')).toBe('plain string failure');
    expect(errorText(undefined)).toBe('The agent hit an unexpected error.');
    expect(errorText({ weird: true })).toBe('The agent hit an unexpected error.');
  });
});
