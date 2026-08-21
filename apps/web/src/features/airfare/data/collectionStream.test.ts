import { describe, expect, it, vi } from 'vitest';

import {
  collectionStreamUrl,
  horizonStreamUrl,
  openCollectionStream,
  openHorizonStream,
} from '@/features/airfare/data/collectionStream';

/** An `EventSource` a test can talk through, as `quoteStream.test` uses. */
class FakeSource {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, (event: Event) => void>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, handler: (event: Event) => void) {
    this.listeners.set(type, handler);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: string) {
    this.listeners.get(type)?.(
      data === undefined ? new Event(type) : new MessageEvent(type, { data }),
    );
  }
}

function openCollection(options: Parameters<typeof openCollectionStream>[0]) {
  let source!: FakeSource;
  const close = openCollectionStream({
    ...options,
    create: (url) => {
      source = new FakeSource(url);
      return source as unknown as EventSource;
    },
  });
  return { source, close };
}

describe('the URL a row follows a pass on', () => {
  it('is the streaming half of the endpoint the poll already used', () => {
    // Same path with `/stream` on it, so the two answers about one pass are
    // findable from each other rather than living in unrelated corners.
    expect(collectionStreamUrl()).toMatch(/\/api\/fares\/collect\/stream$/);
    expect(horizonStreamUrl()).toMatch(/\/api\/fares\/calendar\/collect\/stream$/);
  });
});

describe('openCollectionStream', () => {
  it('hands on the pass document unchanged', () => {
    // The frame *is* `CollectResponse` — the document `GET /collect` answers
    // with — so nothing here reshapes it. That is what lets the row's sentence,
    // its bar and its "whose pass is this" check stay the functions they were.
    const onPass = vi.fn();
    const { source } = openCollection({ onPass });

    source.emit('pass', JSON.stringify({ state: 'running', completed: 4, polling: 31 }));

    expect(onPass).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'running', completed: 4, polling: 31 }),
    );
  });

  it('hands on a snapshot as it landed', () => {
    const onSnapshot = vi.fn();
    const { source } = openCollection({ onPass: vi.fn(), onSnapshot });

    source.emit(
      'snapshot',
      JSON.stringify({ origin: 'LIM', destination: 'SCL', flightDate: '2027-03-09' }),
    );

    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ flightDate: '2027-03-09' }));
  });

  it('ignores a frame it cannot read rather than throwing', () => {
    // The stream sits in front of a poll that still works and a refresh that
    // still happens when the pass ends. It must never be able to break either.
    const onPass = vi.fn();
    const onSnapshot = vi.fn();
    const { source } = openCollection({ onPass, onSnapshot });

    expect(() => source.emit('pass', 'not json')).not.toThrow();
    expect(() => source.emit('snapshot', 'not json')).not.toThrow();
    expect(() => source.emit('pass', JSON.stringify('a string'))).not.toThrow();
    expect(onPass).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('reports the connection opening and failing', () => {
    // `onError` is what arms the row's fallback. Without it a stream that
    // cannot be established leaves the row waiting on a frame that never comes.
    const onOpen = vi.fn();
    const onError = vi.fn();
    const { source } = openCollection({ onPass: vi.fn(), onOpen, onError });

    source.emit('open');
    source.emit('error');

    expect(onOpen).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('closes the connection when told to', () => {
    const { source, close } = openCollection({ onPass: vi.fn() });

    close();

    expect(source.closed).toBe(true);
  });
});

describe('openHorizonStream', () => {
  it('carries the pass and nothing else', () => {
    // No `snapshot` event exists on this stream: a curve is one city pair and
    // two paced requests, so there is no halfway point one could describe.
    const onPass = vi.fn();
    let source!: FakeSource;
    openHorizonStream({
      onPass,
      create: (url) => {
        source = new FakeSource(url);
        return source as unknown as EventSource;
      },
    });

    source.emit('pass', JSON.stringify({ state: 'finished', watching: ['LIM-SCL'] }));
    source.emit('snapshot', JSON.stringify({ origin: 'LIM' }));

    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onPass).toHaveBeenCalledWith(expect.objectContaining({ state: 'finished' }));
  });
});
