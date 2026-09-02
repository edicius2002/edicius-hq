import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toastBus } from './toastBus';
import { ToastHost } from './ToastHost';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();

  // The bus is a module-level singleton; drain it so a toast left over from
  // one test cannot show up rendered by the next.
  let current: { id: string }[] = [];
  const unsubscribe = toastBus.subscribe((toasts) => {
    current = toasts;
  });
  unsubscribe();
  for (const toast of current) toastBus.dismiss(toast.id);
});

describe('ToastHost', () => {
  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<ToastHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a pushed toast and dismisses it on click', () => {
    render(<ToastHost />);
    act(() => {
      toastBus.push({ message: 'AAPL crossed 200', tone: 'buy' });
    });

    expect(screen.getByText('AAPL crossed 200')).toBeInTheDocument();

    // `fireEvent` rather than `userEvent`: userEvent's own internal delays
    // fight fake timers even with `advanceTimers` configured, and this click
    // needs nothing userEvent adds over a plain DOM event.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });

    expect(screen.queryByText('AAPL crossed 200')).not.toBeInTheDocument();
  });

  it('fades out on its own after 5 seconds', () => {
    render(<ToastHost />);
    act(() => {
      toastBus.push({ message: 'auto-dismiss me' });
    });
    expect(screen.getByText('auto-dismiss me')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('auto-dismiss me')).not.toBeInTheDocument();
  });

  it('stacks several toasts, each dismissed by its own timer rather than one shared one', () => {
    render(<ToastHost />);
    act(() => {
      toastBus.push({ message: 'first' });
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      toastBus.push({ message: 'second' });
    });

    // Two seconds later, "first" is at its 5s mark and should be gone —
    // "second" is only 2s in and must still be showing. If the two toasts
    // shared one timer keyed off the whole list, adding "second" would have
    // restarted "first"'s countdown and this would fail.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('first')).not.toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('second')).not.toBeInTheDocument();
  });
});
