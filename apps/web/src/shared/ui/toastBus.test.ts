import { afterEach, describe, expect, it, vi } from 'vitest';

import { toastBus, type Toast } from './toastBus';

function listenerSpy() {
  return vi.fn<(toasts: Toast[]) => void>();
}

// The bus is a module-level singleton, so each test's toasts are cleared
// afterwards to keep the next test's subscribers from seeing them.
afterEach(() => {
  let current: { id: string }[] = [];
  const unsubscribe = toastBus.subscribe((toasts) => {
    current = toasts;
  });
  unsubscribe();
  for (const toast of current) toastBus.dismiss(toast.id);
});

describe('toastBus', () => {
  it('calls a new subscriber back with what is already showing', () => {
    const first = vi.fn();
    const unsubscribeFirst = toastBus.subscribe(first);
    toastBus.push({ message: 'AAPL crossed', tone: 'buy' });

    const second = vi.fn();
    const unsubscribeSecond = toastBus.subscribe(second);
    expect(second).toHaveBeenCalledWith([expect.objectContaining({ message: 'AAPL crossed' })]);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('stacks several toasts rather than replacing the previous one', () => {
    const listener = listenerSpy();
    const unsubscribe = toastBus.subscribe(listener);
    listener.mockClear();

    toastBus.push({ message: 'first' });
    toastBus.push({ message: 'second' });

    const last = listener.mock.calls.at(-1)?.[0] ?? [];
    expect(last.map((toast) => toast.message)).toEqual(expect.arrayContaining(['first', 'second']));
    unsubscribe();
  });

  it('defaults an unspecified tone to neutral', () => {
    const listener = listenerSpy();
    const unsubscribe = toastBus.subscribe(listener);
    const id = toastBus.push({ message: 'no tone given' });

    const pushed = (listener.mock.calls.at(-1)?.[0] ?? []).find((toast) => toast.id === id);
    expect(pushed?.tone).toBe('neutral');
    unsubscribe();
  });

  it('dismisses only the toast asked for, and is a no-op for an unknown id', () => {
    const listener = listenerSpy();
    const unsubscribe = toastBus.subscribe(listener);
    const keep = toastBus.push({ message: 'keep' });
    const drop = toastBus.push({ message: 'drop' });

    listener.mockClear();
    toastBus.dismiss(drop);
    const afterDismiss = listener.mock.calls.at(-1)?.[0] ?? [];
    expect(afterDismiss.map((toast) => toast.id)).toEqual([keep]);

    listener.mockClear();
    toastBus.dismiss('never-existed');
    expect(listener).not.toHaveBeenCalled();

    toastBus.dismiss(keep);
    unsubscribe();
  });
});
