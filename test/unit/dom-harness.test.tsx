// Guards the component-test harness itself (vite-plugin-solid + @solidjs/testing-library
// + jest-dom, wired in vitest.config.ts and test/setup-dom.ts). If Solid's JSX transform
// ever stops running under vitest, a mounted component renders nothing and every
// component spec fails with a confusing "element not found" — this file names the cause.
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

function Probe(props: { onPress: () => void }) {
  const [count, setCount] = createSignal(0);
  return (
    <button
      type="button"
      aria-label="probe"
      onClick={() => {
        setCount(count() + 1);
        props.onPress();
      }}
    >
      pressed {count()}
    </button>
  );
}

describe('component-test harness', () => {
  it('mounts a Solid component and exposes it by role + accessible name', () => {
    render(() => <Probe onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'probe' })).toBeInTheDocument();
  });

  it('runs Solid reactivity and dispatches on click', async () => {
    const onPress = vi.fn();
    render(() => <Probe onPress={onPress} />);
    const btn = screen.getByRole('button', { name: 'probe' });

    expect(btn).toHaveTextContent('pressed 0');
    fireEvent.click(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
    // Reactive re-render, not a full remount — proves the transform is the real Solid one.
    expect(btn).toHaveTextContent('pressed 1');
  });
});
