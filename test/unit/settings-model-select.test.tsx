import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw } from '@/shared/messages';

// First-run setup has to be completable, and the model the panel DISPLAYS has to be the model the
// store holds — the divergence that made a fresh install unable to Save (#165 S2). The control is
// now a combobox (ModelCombobox.tsx) rather than a `<select>`, which adds a second requirement:
// a model id that `/models` never listed (a brand-new one like `minimax/hailuo-3`, or anything
// behind a gateway with an incomplete catalogue) must be typeable/pasteable. Asserted through
// roles and the input's own value — what the user sees and what the store holds are one fact.

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

const modelInput = () => screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement;

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

describe('SettingsPanel model combobox', () => {
  it('a fresh install can Save the model the field is showing', async () => {
    installChromeFake({}); // no saved provider, no key
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(modelInput().value).toBe('openai/gpt-4o-mini'));

    // The displayed model IS the stored one, so Save is actionable without hunting for the
    // "pick a different model, then pick back" workaround.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('filters the list as you type and commits the option you click', async () => {
    installChromeFake({});
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(modelInput().value).toBe('openai/gpt-4o-mini'));

    fireEvent.input(modelInput(), { target: { value: 'sonnet' } });
    // Only the matching model survives the filter (plus the "use what you typed" row).
    await waitFor(() => expect(screen.getByText('Claude Sonnet')).toBeVisible());
    expect(screen.queryByText('GPT-4o mini')).toBeNull();

    fireEvent.click(screen.getByText('Claude Sonnet'));
    expect(modelInput().value).toBe('anthropic/claude-sonnet');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('accepts a pasted model id the endpoint never listed', async () => {
    installChromeFake({});
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(modelInput().value).toBe('openai/gpt-4o-mini'));

    // A brand-new id absent from /models: the whole point of the free-text half of the control.
    fireEvent.input(modelInput(), { target: { value: 'minimax/hailuo-3' } });
    fireEvent.keyDown(modelInput(), { key: 'Enter' });

    expect(modelInput().value).toBe('minimax/hailuo-3');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('commits a pasted id on blur too — clicking Save must not discard it', async () => {
    installChromeFake({});
    await mountPanel();

    fireEvent.input(modelInput(), { target: { value: 'minimax/hailuo-3' } });
    fireEvent.blur(modelInput());

    expect(modelInput().value).toBe('minimax/hailuo-3');
  });

  it('a saved model survives the list load — the default only fills an empty choice', async () => {
    installChromeFake({
      config: { baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet' },
    });
    await mountPanel();

    await waitFor(() => expect(modelInput().value).toBe('anthropic/claude-sonnet'));
  });
});
