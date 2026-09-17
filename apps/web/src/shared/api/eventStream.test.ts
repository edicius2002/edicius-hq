import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  clearLocalSession: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('@/shared/auth/supabaseAuth', () => auth);

import { openApiEventStream } from '@/shared/api/eventStream';

const encoder = new TextEncoder();

function streamResponse(chunks: Array<string | Uint8Array>, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
    { status },
  );
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.getAccessToken.mockResolvedValue('jwt-one');
  auth.clearLocalSession.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('openApiEventStream', () => {
  it('parses split chunks, preserves ids, and reconnects with bearer headers', async () => {
    const chunks = [
      'id: 41\nevent: quo',
      'tes\ndata: [{"symbol":"AAPL"}]\n\n',
      ': keep-alive\n\nid: 42\nevent: quotes\ndata: []\n\n',
    ];
    const fetchSpy = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(streamResponse(chunks))
      .mockResolvedValue(streamResponse([]));
    vi.stubGlobal('fetch', fetchSpy);
    const onEvent = vi.fn();

    const close = openApiEventStream('/api/market/stream?symbols=AAPL%2CMSFT', { onEvent });
    await settle();

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, {
      type: 'quotes',
      data: '[{"symbol":"AAPL"}]',
      id: '41',
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: 'quotes', data: '[]', id: '42' });
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('token=');
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer jwt-one',
    );

    await vi.advanceTimersByTimeAsync(3_000);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Last-Event-ID')).toBe('42');
    close();
  });

  it('joins repeated data fields, defaults unnamed events, and ignores comments', async () => {
    const fetchSpy = vi.fn(async () =>
      streamResponse([': keep-alive\n\ndata: first\ndata: second\n\n']),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const onEvent = vi.fn();

    const close = openApiEventStream('/api/stream', { onEvent });
    await settle();

    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'message',
      data: 'first\nsecond',
      id: null,
    });
    close();
  });

  it('keeps the last nonempty id across frames and split UTF-8 input', async () => {
    const frame = encoder.encode(
      'id: 41\ndata: café\n\nevent: note\ndata: later\n\nid:\ndata: retained\n\n',
    );
    const accentedByte = frame.indexOf(0xc3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse([frame.slice(0, accentedByte + 1), frame.slice(accentedByte + 1)]),
      ),
    );
    const onEvent = vi.fn();

    const close = openApiEventStream('/api/stream', { onEvent });
    await settle();

    expect(onEvent).toHaveBeenNthCalledWith(1, { type: 'message', data: 'café', id: '41' });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: 'note', data: 'later', id: '41' });
    expect(onEvent).toHaveBeenNthCalledWith(3, { type: 'message', data: 'retained', id: '41' });
    close();
  });

  it('does not reconnect after it is aborted', async () => {
    const fetchSpy = vi.fn(async () => streamResponse(['data: one\n\n']));
    vi.stubGlobal('fetch', fetchSpy);

    const close = openApiEventStream('/api/stream', { onEvent: vi.fn() });
    await settle();
    close();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('uses the auth-expired path for a 401 stream response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse([], 401)),
    );
    const onError = vi.fn();

    const close = openApiEventStream('/api/stream', { onEvent: vi.fn(), onError });
    await settle();

    expect(auth.clearLocalSession).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    close();
  });
});
