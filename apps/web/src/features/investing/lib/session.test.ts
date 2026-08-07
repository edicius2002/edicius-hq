import { describe, expect, it } from 'vitest';

import {
  cadenceFor,
  exchangeTime,
  hasSession,
  isExtendedBar,
  openedBetween,
  regimeAt,
} from '@/features/investing/lib/session';

/**
 * Every fixture is written as a UTC instant, because a local time would mean
 * something different on the machine that runs this than on the one that wrote
 * it. New York is UTC-5 in winter and UTC-4 in summer, which is the whole point
 * of the daylight-saving cases below.
 */
const utc = (iso: string) => new Date(iso);

describe('exchangeTime', () => {
  it('reads winter time as UTC-5', () => {
    // 2026-01-15 is a Thursday.
    expect(exchangeTime(utc('2026-01-15T14:30:00Z'))).toEqual({ minutes: 9 * 60 + 30, weekday: 4 });
  });

  it('reads summer time as UTC-4', () => {
    // 2026-07-15 is a Wednesday.
    expect(exchangeTime(utc('2026-07-15T13:30:00Z'))).toEqual({ minutes: 9 * 60 + 30, weekday: 3 });
  });

  it('handles midnight without rolling to twenty-four', () => {
    expect(exchangeTime(utc('2026-01-15T05:00:00Z')).minutes).toBe(0);
  });
});

describe('regimeAt', () => {
  it('is regular between the open and the close', () => {
    expect(regimeAt(utc('2026-01-15T14:30:00Z'))).toBe('regular'); // 09:30
    expect(regimeAt(utc('2026-01-15T18:00:00Z'))).toBe('regular'); // 13:00
    expect(regimeAt(utc('2026-01-15T20:59:00Z'))).toBe('regular'); // 15:59
  });

  it('is extended before the open and after the close', () => {
    expect(regimeAt(utc('2026-01-15T09:00:00Z'))).toBe('extended'); // 04:00
    expect(regimeAt(utc('2026-01-15T14:29:00Z'))).toBe('extended'); // 09:29
    expect(regimeAt(utc('2026-01-15T21:00:00Z'))).toBe('extended'); // 16:00
    expect(regimeAt(utc('2026-01-16T00:59:00Z'))).toBe('extended'); // 19:59
  });

  it('is closed overnight, when nothing trades at all', () => {
    expect(regimeAt(utc('2026-01-16T01:00:00Z'))).toBe('closed'); // 20:00
    expect(regimeAt(utc('2026-01-16T06:00:00Z'))).toBe('closed'); // 01:00
    expect(regimeAt(utc('2026-01-15T08:59:00Z'))).toBe('closed'); // 03:59
  });

  it('is closed all weekend', () => {
    // 2026-01-17 is a Saturday, 2026-01-18 a Sunday — both mid-session by clock.
    expect(regimeAt(utc('2026-01-17T18:00:00Z'))).toBe('closed');
    expect(regimeAt(utc('2026-01-18T18:00:00Z'))).toBe('closed');
  });

  describe('across daylight saving', () => {
    // US DST began 2026-03-08 and ends 2026-11-01.
    it('opens at 14:30 UTC the day before the clocks move', () => {
      expect(regimeAt(utc('2026-03-06T14:30:00Z'))).toBe('regular');
      expect(regimeAt(utc('2026-03-06T13:30:00Z'))).toBe('extended');
    });

    it('opens an hour earlier in UTC once they have', () => {
      // 2026-03-09, the Monday after the change: 13:30 UTC is now 09:30 local.
      expect(regimeAt(utc('2026-03-09T13:30:00Z'))).toBe('regular');
      // What was the open a week earlier is now an hour into the session.
      expect(regimeAt(utc('2026-03-09T14:30:00Z'))).toBe('regular');
      expect(regimeAt(utc('2026-03-09T13:29:00Z'))).toBe('extended');
    });

    it('goes back again in November', () => {
      expect(regimeAt(utc('2026-11-02T14:30:00Z'))).toBe('regular');
      expect(regimeAt(utc('2026-11-02T13:30:00Z'))).toBe('extended');
    });
  });
});

describe('isExtendedBar', () => {
  it('marks a bar by its own timestamp, not by when it was fetched', () => {
    const preMarket = Date.parse('2026-01-15T13:00:00Z') / 1000; // 08:00 ET
    const midSession = Date.parse('2026-01-15T18:00:00Z') / 1000; // 13:00 ET

    expect(isExtendedBar(preMarket)).toBe(true);
    expect(isExtendedBar(midSession)).toBe(false);
  });
});

describe('openedBetween', () => {
  it('sees the open happen across two polls', () => {
    expect(openedBetween(utc('2026-01-15T14:29:00Z'), utc('2026-01-15T14:31:00Z'))).toBe(true);
  });

  it('does not fire twice for one open', () => {
    expect(openedBetween(utc('2026-01-15T14:31:00Z'), utc('2026-01-15T15:00:00Z'))).toBe(false);
  });

  it('catches an open a sleeping machine slept through', () => {
    // A timer set for 09:30 would have been missed; a comparison is not.
    expect(openedBetween(utc('2026-01-15T06:00:00Z'), utc('2026-01-15T16:00:00Z'))).toBe(true);
  });

  it('does not fire on the close', () => {
    expect(openedBetween(utc('2026-01-15T20:59:00Z'), utc('2026-01-15T21:01:00Z'))).toBe(false);
  });

  it('ignores time running backwards', () => {
    expect(openedBetween(utc('2026-01-15T16:00:00Z'), utc('2026-01-15T06:00:00Z'))).toBe(false);
  });
});

describe('cadenceFor', () => {
  it('follows the timeframe while the market is open', () => {
    expect(cadenceFor('regular', 10_000)).toEqual({ barsMs: 10_000, quotesMs: 15_000 });
  });

  it('slows down outside the session', () => {
    expect(cadenceFor('extended', 10_000)).toEqual({ barsMs: 60_000, quotesMs: 60_000 });
  });

  it('stops asking for bars when nothing is trading', () => {
    const cadence = cadenceFor('closed', 10_000);
    expect(cadence.barsMs).toBeNull();
    expect(cadence.quotesMs).toBe(900_000);
  });
});

describe('hasSession', () => {
  it('is false for crypto, which never closes', () => {
    expect(hasSession('binance')).toBe(false);
    expect(hasSession('yahoo')).toBe(true);
  });
});
