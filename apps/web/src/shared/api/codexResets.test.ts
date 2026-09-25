import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCodexResets } from '@/shared/api/codexResets';

/*
 * The card reads codex-resets.com directly. It used to go through the home
 * API's `/api/codex-resets`, and production has no API behind
 * `localhost:8000`, so the card never loaded. The provider answers any origin
 * (`Access-Control-Allow-Origin: *`), so the normalisation the API did now
 * happens here. Shapes below are trimmed from real responses.
 */

const UPSTREAM = 'https://codex-resets.com/api/v1';

function reset(id: string, announcedAt: string, type: 'regular' | 'banked' = 'regular') {
  return {
    id,
    reset_type: type,
    announced_at: announcedAt,
    text: `reset ${id}`,
    source: {
      type: 'x_post',
      author: 'thsottiaux',
      url: `https://x.com/thsottiaux/status/${id}`,
    },
  };
}

const STATUS = {
  data: {
    latest_reset: reset('3', '2026-09-22T18:23:37.000Z', 'banked'),
    scheduled_reset: null,
    active_watch: null,
    stats: { total: 3, last_reset_at: '2026-09-22T18:23:37.000Z', avg_interval_days: 7 },
  },
  meta: { api_version: 'v1', generated_at: '2026-09-25T20:00:00.000Z' },
};

function serve(routes: Record<string, unknown>, calls: string[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(routes).find((path) => url.startsWith(`${UPSTREAM}${path}`));
      const body = key === undefined ? undefined : routes[key];
      if (body instanceof Response) return Promise.resolve(body);
      return Promise.resolve(
        body === undefined ? new Response('not found', { status: 404 }) : Response.json(body),
      );
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCodexResets', () => {
  it('reads the provider directly and hands the card the shape it already draws', async () => {
    const calls = serve({
      '/status': STATUS,
      '/resets': {
        data: [
          reset('1', '2026-09-01T00:00:00Z'),
          reset('3', '2026-09-22T18:23:37.000Z', 'banked'),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
    });

    const snapshot = await fetchCodexResets();

    expect(calls[0]).toBe(`${UPSTREAM}/status`);
    expect(calls[1]).toBe(`${UPSTREAM}/resets?limit=100&order=asc`);
    expect(snapshot).toMatchObject({
      source: 'codex-resets.com',
      generatedAt: '2026-09-25T20:00:00Z',
      stale: false,
      latestReset: { id: '3', resetType: 'banked', announcedAt: '2026-09-22T18:23:37Z' },
      stats: { total: 3, avgIntervalDays: 7 },
    });
    expect(snapshot.resets.map((item) => item.id)).toEqual(['1', '3']);
    expect(snapshot.resets[0].source).toEqual({
      type: 'x_post',
      author: 'thsottiaux',
      url: 'https://x.com/thsottiaux/status/1',
    });
  });

  it('follows every page, keeps each reset once, and orders them by when they happened', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/status')) return Promise.resolve(Response.json(STATUS));
        if (!url.includes('cursor=')) {
          return Promise.resolve(
            Response.json({
              data: [reset('2', '2026-09-10T00:00:00Z'), reset('1', '2026-09-01T00:00:00Z')],
              pagination: { has_more: true, next_cursor: 'page-2' },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            data: [reset('2', '2026-09-10T00:00:00Z'), reset('3', '2026-09-22T18:23:37Z')],
            pagination: { has_more: false, next_cursor: null },
          }),
        );
      }),
    );

    const snapshot = await fetchCodexResets();

    expect(calls[2]).toBe(`${UPSTREAM}/resets?limit=100&order=asc&cursor=page-2`);
    expect(snapshot.resets.map((item) => item.id)).toEqual(['1', '2', '3']);
    // 1 Sep → 10 Sep is 9 days, 10 Sep → 22 Sep 18:23 is the longer gap.
    expect(snapshot.stats.longestIntervalDays).toBeCloseTo(12.766, 2);
  });

  it('has no longest interval until there are two resets to measure between', async () => {
    serve({
      '/status': STATUS,
      '/resets': { data: [reset('1', '2026-09-01T00:00:00Z')], pagination: { has_more: false } },
    });
    expect((await fetchCodexResets()).stats.longestIntervalDays).toBeNull();
  });

  it('refuses a malformed reset rather than drawing it', async () => {
    serve({
      '/status': STATUS,
      '/resets': {
        data: [{ ...reset('1', '2026-09-01T00:00:00Z'), reset_type: 'scheduled' }],
        pagination: { has_more: false },
      },
    });
    await expect(fetchCodexResets()).rejects.toThrow(/reset_type/);
  });

  it('refuses a timestamp without a timezone', async () => {
    serve({
      '/status': STATUS,
      '/resets': {
        data: [reset('1', '2026-09-01T00:00:00')],
        pagination: { has_more: false },
      },
    });
    await expect(fetchCodexResets()).rejects.toThrow(/timezone/);
  });

  it('says when the provider is rate limiting', async () => {
    serve({ '/status': new Response('slow down', { status: 429 }) });
    await expect(fetchCodexResets()).rejects.toThrow(/rate-limited/);
  });

  it('refuses a pagination cursor that repeats instead of looping forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input).endsWith('/status')
            ? Response.json(STATUS)
            : Response.json({
                data: [reset('1', '2026-09-01T00:00:00Z')],
                pagination: { has_more: true, next_cursor: 'same' },
              }),
        ),
      ),
    );
    await expect(fetchCodexResets()).rejects.toThrow(/cursor/);
  });
});
