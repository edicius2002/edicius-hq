import { afterEach, describe, expect, it, vi } from 'vitest';

const { from, channel, removeChannel, limit, order, eq, maybeSingle, on } = vi.hoisted(() => {
  const mockedMaybeSingle = vi.fn();
  const mockedLimit = vi.fn<() => unknown>(() => ({ maybeSingle: mockedMaybeSingle }));
  const mockedOrder = vi.fn(() => ({ limit: mockedLimit }));
  const mockedEq = vi.fn(() => ({ order: mockedOrder }));
  const mockedSelect = vi.fn(() => ({ eq: mockedEq }));
  const mockedFrom = vi.fn(() => ({ select: mockedSelect }));
  const mockedSubscribe = vi.fn(() => ({ id: 'tweets' }));
  const mockedOn = vi.fn(() => ({ subscribe: mockedSubscribe }));
  return {
    from: mockedFrom,
    channel: vi.fn(() => ({ on: mockedOn })),
    removeChannel: vi.fn(),
    limit: mockedLimit,
    order: mockedOrder,
    eq: mockedEq,
    maybeSingle: mockedMaybeSingle,
    on: mockedOn,
  };
});

vi.mock('@/shared/supabase/client', () => ({ supabase: { from, channel, removeChannel } }));

import { fetchLatestTweetRun, fetchTweets, subscribeTweets } from './supabaseTweets';

afterEach(() => vi.clearAllMocks());

describe('dashboard tweet data', () => {
  it('reads newest owner-visible tweet rows for the configured handle', async () => {
    limit.mockResolvedValue({
      data: [
        {
          post_id: 'post-1',
          posted_at: '2026-09-18T10:00:00Z',
          payload: { text: 'stored post', is_reply: false, url: 'https://x.com/a/1' },
        },
      ],
      error: null,
    });

    await expect(fetchTweets('thsottiaux')).resolves.toEqual([
      {
        id: 'post-1',
        date: '2026-09-18T10:00:00Z',
        text: 'stored post',
        isReply: false,
        url: 'https://x.com/a/1',
      },
    ]);
    expect(from).toHaveBeenCalledWith('tweet_posts');
    expect(eq).toHaveBeenCalledWith('handle', 'thsottiaux');
    expect(order).toHaveBeenCalledWith('posted_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(500);
  });

  it('reads the newest X collector run', async () => {
    limit.mockImplementation(() => ({ maybeSingle }));
    maybeSingle.mockResolvedValue({
      data: { status: 'complete', completed_at: '2026-09-18T11:00:00Z' },
      error: null,
    });

    await expect(fetchLatestTweetRun()).resolves.toEqual({
      status: 'complete',
      completed_at: '2026-09-18T11:00:00Z',
    });
    expect(from).toHaveBeenCalledWith('collector_runs');
    expect(eq).toHaveBeenCalledWith('collector', 'x-posts');
  });

  it('subscribes to inserts for this handle and removes its channel', () => {
    const onInsert = vi.fn();
    const close = subscribeTweets('thsottiaux', onInsert);

    expect(channel).toHaveBeenCalledWith('tweets:thsottiaux');
    expect(on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'tweet_posts', filter: 'handle=eq.thsottiaux' },
      onInsert,
    );
    close();
    expect(removeChannel).toHaveBeenCalledWith({ id: 'tweets' });
  });
});
