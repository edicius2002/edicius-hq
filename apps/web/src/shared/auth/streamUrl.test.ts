import { afterEach, describe, expect, it } from 'vitest';

import COLLECTION_STREAM_SOURCE from '@/features/airfare/data/collectionStream.ts?raw';
import QUOTE_STREAM_SOURCE from '@/features/investing/data/quoteStream.ts?raw';
import TWEETS_SOURCE from '@/shared/api/tweets.ts?raw';
import { clearToken, readToken, writeToken } from '@/shared/auth/session';
import { withStreamToken } from '@/shared/auth/streamUrl';

afterEach(() => {
  clearToken();
});

describe('withStreamToken', () => {
  it('appends the token to a URL that already carries a query string', () => {
    writeToken('a-token');
    expect(withStreamToken('https://pc.example/api/market/stream?symbols=AAPL')).toBe(
      'https://pc.example/api/market/stream?symbols=AAPL&token=a-token',
    );
  });

  it('starts a query string on a URL that has none', () => {
    writeToken('a-token');
    expect(withStreamToken('https://pc.example/api/tweets/x/stream')).toBe(
      'https://pc.example/api/tweets/x/stream?token=a-token',
    );
  });

  it('leaves the URL untouched when there is no token', () => {
    expect(withStreamToken('https://pc.example/api/market/stream?symbols=AAPL')).toBe(
      'https://pc.example/api/market/stream?symbols=AAPL',
    );
  });

  it('escapes a token that would otherwise break the query string', () => {
    writeToken('a token&with=trouble');
    expect(withStreamToken('https://pc.example/s')).toBe(
      'https://pc.example/s?token=a%20token%26with%3Dtrouble',
    );
  });
});

describe('the session token', () => {
  it('round-trips and clears', () => {
    writeToken('a-token');
    expect(readToken()).toBe('a-token');
    clearToken();
    expect(readToken()).toBeNull();
  });
});

/*
 * There are FOUR `EventSource` constructions in THREE files. Three share an
 * `options.create` seam and `shared/api/tweets.ts` does not, and that asymmetry
 * has already caused a miscount in this repository's own documentation — the
 * four were written up as three. So this test names the files rather than
 * trusting a future reader to find them, and counts constructions against
 * wrappings, so a fifth stream added to any of these files cannot go
 * untokenised without going red.
 *
 * Read through Vite's `?raw` rather than `node:fs`, for the reason
 * `test/vercelConfig.test.ts` writes out at length: `tsconfig.app.json` types
 * this workspace as `["vite/client"]`, so a `readFileSync` here fails
 * `typecheck` and `lint` rather than protecting anything.
 */
const STREAM_SITES: ReadonlyArray<readonly [string, string]> = [
  ['src/features/investing/data/quoteStream.ts', QUOTE_STREAM_SOURCE],
  ['src/features/airfare/data/collectionStream.ts', COLLECTION_STREAM_SOURCE],
  ['src/shared/api/tweets.ts', TWEETS_SOURCE],
];

function count(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

describe('every EventSource carries the session token', () => {
  it.each(STREAM_SITES)('%s builds its URL through withStreamToken', (_file, source) => {
    const constructions = count(source, /new EventSource\(/g);

    expect(constructions).toBeGreaterThan(0);
    expect(count(source, /withStreamToken\(/g)).toBeGreaterThanOrEqual(constructions);
  });

  it('accounts for all four constructions across the three files', () => {
    const total = STREAM_SITES.reduce(
      (running, [, source]) => running + count(source, /new EventSource\(/g),
      0,
    );

    expect(total).toBe(4);
  });
});
