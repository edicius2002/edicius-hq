import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/auth/supabaseAuth', () => ({
  clearLocalSession: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { openCollectionStream, openHorizonStream } from '@/features/airfare/data/collectionStream';
import type { EventStreamHandlers } from '@/shared/api/eventStream';

function openCollection(options: Parameters<typeof openCollectionStream>[0]) {
  let handlers!: EventStreamHandlers;
  const stop = vi.fn();
  const open = vi.fn((_: string, next: EventStreamHandlers) => {
    handlers = next;
    return stop;
  });
  const close = openCollectionStream({
    ...options,
    open,
  });
  return { handlers, close, open, stop };
}

describe('openCollectionStream', () => {
  it('hands on the pass document unchanged', () => {
    // The frame *is* `CollectResponse` — the document `GET /collect` answers
    // with — so nothing here reshapes it. That is what lets the row's sentence,
    // its bar and its "whose pass is this" check stay the functions they were.
    const onPass = vi.fn();
    const { handlers } = openCollection({ onPass });

    handlers.onEvent({
      type: 'pass',
      data: JSON.stringify({ state: 'running', completed: 4, polling: 31 }),
      id: null,
    });

    expect(onPass).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'running', completed: 4, polling: 31 }),
    );
  });

  it('hands on a snapshot as it landed', () => {
    const onSnapshot = vi.fn();
    const { handlers } = openCollection({ onPass: vi.fn(), onSnapshot });

    handlers.onEvent({
      type: 'snapshot',
      data: JSON.stringify({ origin: 'LIM', destination: 'SCL', flightDate: '2027-03-09' }),
      id: null,
    });

    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ flightDate: '2027-03-09' }));
  });

  it('ignores a frame it cannot read rather than throwing', () => {
    // The stream sits in front of a poll that still works and a refresh that
    // still happens when the pass ends. It must never be able to break either.
    const onPass = vi.fn();
    const onSnapshot = vi.fn();
    const { handlers } = openCollection({ onPass, onSnapshot });

    expect(() => handlers.onEvent({ type: 'pass', data: 'not json', id: null })).not.toThrow();
    expect(() => handlers.onEvent({ type: 'snapshot', data: 'not json', id: null })).not.toThrow();
    expect(() =>
      handlers.onEvent({ type: 'pass', data: JSON.stringify('a string'), id: null }),
    ).not.toThrow();
    expect(onPass).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('reports the connection opening and failing', () => {
    // `onError` is what arms the row's fallback. Without it a stream that
    // cannot be established leaves the row waiting on a frame that never comes.
    const onOpen = vi.fn();
    const onError = vi.fn();
    const { handlers } = openCollection({ onPass: vi.fn(), onOpen, onError });

    handlers.onOpen?.();
    handlers.onError?.();

    expect(onOpen).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('opens the board endpoint and closes the connection when told to', () => {
    const { close, open, stop } = openCollection({ onPass: vi.fn() });

    close();

    expect(open).toHaveBeenCalledWith(
      '/api/fares/collect/stream',
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('openHorizonStream', () => {
  it('carries the pass and nothing else', () => {
    // No `snapshot` event exists on this stream: a curve is one city pair and
    // two paced requests, so there is no halfway point one could describe.
    const onPass = vi.fn();
    let handlers!: EventStreamHandlers;
    const open = vi.fn((_: string, next: EventStreamHandlers) => {
      handlers = next;
      return vi.fn();
    });
    openHorizonStream({
      onPass,
      open,
    });

    handlers.onEvent({
      type: 'pass',
      data: JSON.stringify({ state: 'finished', watching: ['LIM-SCL'] }),
      id: null,
    });
    handlers.onEvent({ type: 'snapshot', data: JSON.stringify({ origin: 'LIM' }), id: null });

    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onPass).toHaveBeenCalledWith(expect.objectContaining({ state: 'finished' }));
    expect(open).toHaveBeenCalledWith(
      '/api/fares/calendar/collect/stream',
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
  });
});
