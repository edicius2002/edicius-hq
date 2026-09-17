import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/auth/supabaseAuth', () => ({
  clearLocalSession: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { openTweetStream } from '@/shared/api/tweets';
import type { EventStreamHandlers } from '@/shared/api/eventStream';

describe('openTweetStream', () => {
  it('opens the encoded API stream and only forwards tweet events', () => {
    let handlers!: EventStreamHandlers;
    const stop = vi.fn();
    const open = vi.fn((_: string, next: EventStreamHandlers) => {
      handlers = next;
      return stop;
    });
    const onTweets = vi.fn();

    const close = openTweetStream('name/with space', onTweets, open);

    handlers.onEvent({ type: 'message', data: '', id: null });
    handlers.onEvent({ type: 'tweets', data: '', id: '91' });
    close();

    expect(onTweets).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      '/api/tweets/name%2Fwith%20space/stream',
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
    expect(stop).toHaveBeenCalledOnce();
  });
});
