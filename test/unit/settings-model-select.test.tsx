import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// First-run setup has to be completable. The model `<select>` used to carry no `value` binding —
// only per-option `selected` — so with `settings.model` still null NO option was selected, the
// browser fell back to displaying option 0, and Save stayed disabled on `!settings.model`.
// Re-opening the dropdown and clicking the model already displayed fires no `change` event, so the
// only escape was picking a model the user did not want (#165 S2). Asserted through roles and the
// element's own value — what the user sees and what the store holds have to be the same fact.

const MODELS = [
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
  { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet' },
];

function installChromeFake(provider: { config?: { baseURL: string; model: string } }): void {
  const sendMessage = vi.fn(async (raw: unknown) => {
    const msg = raw as PanelToSw;
    switch (msg.type) {
      case 'get-provider':
        return provider.config ? { ok: true, config: provider.config, hasKey: true } : { ok: true };
      case 'list-models':
        return { ok: true, models: MODELS };
      default:
        return { ok: true };
    }
  });
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
}

const modelSelect = () => screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;

/** Mount a panel over a FRESH module graph: `stores/settings.ts` is a module singleton, so a
 *  panel re-rendered over the previous spec's store would start with its models and its pick. */
async function mountPanel(): Promise<void> {
  const { SettingsPanel } = await import('@/entrypoints/sidepanel/components/SettingsPanel');
  render(() => <SettingsPanel />);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('SettingsPanel model select', () => {
  it('a fresh install can Save the model the dropdown is showing', async () => {
    installChromeFake({}); // no saved provider, no key
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'GPT-4o mini' })).toBeVisible());

    // The displayed model IS the stored one, so Save is actionable without hunting for the
    // "pick a different model, then pick back" workaround.
    expect(modelSelect().value).toBe('openai/gpt-4o-mini');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('an explicit pick wins and stays selected', async () => {
    installChromeFake({});
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Claude Sonnet' })).toBeVisible(),
    );
    fireEvent.change(modelSelect(), { target: { value: 'anthropic/claude-sonnet' } });

    expect(modelSelect().value).toBe('anthropic/claude-sonnet');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a saved model survives the list load — the default only fills an empty choice', async () => {
    installChromeFake({
      config: { baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet' },
    });
    await mountPanel();

    await waitFor(() => expect(screen.getByRole('option', { name: 'GPT-4o mini' })).toBeVisible());
    expect(modelSelect().value).toBe('anthropic/claude-sonnet');
  });
});
