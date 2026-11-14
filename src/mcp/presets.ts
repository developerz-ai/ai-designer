import type { AuthKind } from '@/shared/messages';

export interface McpBackendPreset {
  id: string;
  label: string;
  url: string;
  authKind: AuthKind;
}

/**
 * Built-in backends offered by the side-panel quick-add controls.
 *
 * Empty on purpose. A preset ships its URL in the public tree and in every published build, and
 * the one this list held named a service endpoint on our own infrastructure (#256). Users add
 * their backend by URL in the MCP panel; the quick-add row renders nothing while this is empty.
 * A preset added back must name a host the public may be told about — the public-tree guard
 * (`test/unit/public-tree.test.ts`) fails on a host on our own domain that is not public.
 */
export const MCP_BACKEND_PRESETS: readonly McpBackendPreset[] = [];
