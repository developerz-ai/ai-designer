// Prompt-cache breakpoint helpers (#168, OpenRouter/Anthropic path). OpenAI-compatible prompt
// caching is PREFIX-based and mostly automatic; Anthropic models routed through OpenRouter
// additionally honour explicit `cache_control` breakpoints forwarded from the request JSON.
// `@ai-sdk/openai-compatible` (verified against the installed 1.x dist) spreads a message's —
// or a content part's — `providerOptions.openaiCompatible` object straight into the serialized
// OpenAI JSON, so `{ cache_control: { type: 'ephemeral' } }` lands exactly where OpenRouter
// documents it (on a content part; message-level for the string-content system message).
//
// OPT-IN, caller's call: some strict OpenAI-compatible endpoints reject unknown fields, so the
// caller (background's turn assembly) should only annotate when the configured baseURL is
// OpenRouter (or another endpoint known to tolerate/forward `cache_control`). These helpers are
// pure and never decide that.
//
// Placement doctrine (why two helpers): one breakpoint after the byte-stable system prompt
// (caches the instruction block across every turn), one on the last message of the PERSISTED
// thread (caches the whole prior conversation; the new user message and the turn's streaming
// steps grow past it without invalidating it).

import { z } from 'zod';
import type { ChatMessage } from './session';

/** `providerOptions` payload that becomes `cache_control: {type:'ephemeral'}` in the request. */
export const EPHEMERAL_CACHE_PROVIDER_OPTIONS = {
  openaiCompatible: { cache_control: { type: 'ephemeral' } },
} as const;

const SystemMessage = z.object({
  role: z.literal('system'),
  content: z.string(),
});

export type CachedSystemMessage = z.infer<typeof SystemMessage> & {
  providerOptions: typeof EPHEMERAL_CACHE_PROVIDER_OPTIONS;
};

/**
 * Wrap the assembled system prompt as a `SystemModelMessage` carrying a cache breakpoint —
 * pass it to `runTurn` as `instructions` (the loop accepts `Instructions`, i.e. string OR
 * system message). The prompt string itself must stay byte-stable across turns for the
 * breakpoint to ever hit (see `system-prompt.ts`).
 */
export function cachedSystemPrompt(prompt: string): CachedSystemMessage {
  return { role: 'system', content: prompt, providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS };
}

/**
 * Return a copy of `message` annotated with a cache breakpoint. For a string-content user
 * message the content becomes a single text part carrying the annotation (the provider's
 * single-text shortcut spreads part metadata correctly); for array content the LAST text part
 * is annotated; other roles annotate at message level. Pure — the input is never mutated.
 */
export function withCacheBreakpoint(message: ChatMessage): ChatMessage {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: [
          {
            type: 'text',
            text: message.content,
            providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS,
          },
        ],
      };
    }
    const lastText = message.content.map((p) => p.type).lastIndexOf('text');
    if (lastText >= 0) {
      return {
        ...message,
        content: message.content.map((part, index) =>
          index === lastText && part.type === 'text'
            ? { ...part, providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS }
            : part,
        ),
      };
    }
  }
  return { ...message, providerOptions: EPHEMERAL_CACHE_PROVIDER_OPTIONS };
}
