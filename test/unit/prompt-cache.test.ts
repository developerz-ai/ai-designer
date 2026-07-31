import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  cachedSystemPrompt,
  EPHEMERAL_CACHE_PROVIDER_OPTIONS,
  withCacheBreakpoint,
} from '@/agent/prompt-cache';
import type { ChatMessage } from '@/agent/session';

// prompt-cache.ts unit: the opt-in cache_control breakpoint helpers for the OpenRouter/Anthropic
// path (#168). `@ai-sdk/openai-compatible` spreads `providerOptions.openaiCompatible` into the
// serialized JSON, so these just have to put the annotation in the documented place — and stay
// pure + schema-valid.

describe('cachedSystemPrompt', () => {
  it('wraps the prompt as a system message carrying the ephemeral cache annotation', () => {
    const message = cachedSystemPrompt('You are a design agent.');
    expect(message).toEqual({
      role: 'system',
      content: 'You are a design agent.',
      providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS,
    });
    expect(modelMessageSchema.safeParse(message).success).toBe(true);
  });
});

describe('withCacheBreakpoint', () => {
  it('annotates a string-content user message via a single text part (the provider’s single-text shortcut)', () => {
    const original: ChatMessage = { role: 'user', content: 'make it pop' };
    const annotated = withCacheBreakpoint(original);
    expect(annotated).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'make it pop', providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS },
      ],
    });
    expect(original.content).toBe('make it pop'); // input untouched
    expect(modelMessageSchema.safeParse(annotated).success).toBe(true);
  });

  it('annotates the LAST text part of array content', () => {
    const annotated = withCacheBreakpoint({
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'last' },
      ],
    });
    if (annotated.role !== 'user' || typeof annotated.content === 'string') {
      throw new Error('shape');
    }
    expect(annotated.content[0]).toEqual({ type: 'text', text: 'first' });
    expect(annotated.content[1]).toEqual({
      type: 'text',
      text: 'last',
      providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS,
    });
  });

  it('falls back to message-level annotation for other roles', () => {
    const annotated = withCacheBreakpoint({ role: 'assistant', content: 'done' });
    expect(annotated).toEqual({
      role: 'assistant',
      content: 'done',
      providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS,
    });
    expect(modelMessageSchema.safeParse(annotated).success).toBe(true);
  });
});
