import type { SpendKind } from '@/shared/api/fares';

/**
 * The day's spend as a strip can draw it: where the marks fall, what the
 * requests went on, and when the count starts again.
 *
 * Pure and its own module for `rowReport`'s reason: what a readout does at each
 * of its awkward moments is the part worth pinning, and a test that has to
 * mount a header to find out whether a mark is drawn is testing the header.
 *
 * Every function here can answer "nothing", and that is the point of them. This
 * feature draws nothing rather than a fallback — 12.234 — so a mark that would
 * have to be placed by guesswork, a breakdown with no lines behind it and a
 * timestamp that will not parse all come back `null` and are simply not
 * rendered.
 */

/** Where the two marks sit on a track that runs from nothing to the ceiling. */
export type SpendMarks = {
  /** 0 to 1. How much of the ceiling today has spent, clamped at full. */
  fill: number;
  /**
   * 0 to 1, or null when the busiest day on record is not inside the track.
   *
   * This mark is the whole reason the track is honest. The ceiling is a
   * judgement — the API says so in the field's own documentation — and a bar
   * filling towards it reads as a fraction of a safe maximum unless something
   * on the same track is a measured number. 329 is that number.
   *
   * Null where it cannot be drawn truthfully: a ceiling at or below the busiest
   * day would put the mark on or past the end, where it would read as "the
   * ceiling" rather than as a separate fact.
   */
  busiest: number | null;
};

/**
 * Where to put the fill and the high-water mark, or null when there is no track.
 *
 * Null on an unreadable ledger, because the honest length of a bar for a day
 * whose spend cannot be established is no bar at all — the words carry that
 * case, and a track drawn empty beside them would be the picture contradicting
 * the sentence. Null too on a ceiling of zero or less, which has no scale.
 */
export function spendMarks(
  spent: number | null,
  ceiling: number,
  busiestOnRecord: number,
): SpendMarks | null {
  if (spent === null || !Number.isFinite(ceiling) || ceiling <= 0) return null;

  return {
    fill: Math.max(0, Math.min(1, spent / ceiling)),
    busiest: busiestOnRecord > 0 && busiestOnRecord < ceiling ? busiestOnRecord / ceiling : null,
  };
}

/**
 * What the day's requests went on, in a line — `412 boards · 29 calendars`.
 *
 * Counts rather than routes, and it is the only breakdown on the strip. A table
 * per route is as long as the watchlist and would make a readout about our own
 * spending into a second copy of the panel below it; the ledger file itself is
 * where somebody tuning a cadence should look, which is what its `what` field
 * is for. What a reader can act on from here is *which half* of the collector
 * is spending — the half-hourly boards or the daily curves.
 *
 * Null when there is nothing to say, which is a day with no requests in it and
 * also a ledger that could not be parsed. Both draw no line rather than an
 * empty one.
 */
export function describeKinds(kinds: readonly SpendKind[]): string | null {
  const named = kinds.filter((kind) => kind.requests > 0);
  if (named.length === 0) return null;
  return named
    .map((kind) => `${kind.requests} ${kind.kind}${kind.requests === 1 ? '' : 's'}`)
    .join(' · ');
}

/**
 * When the day turns over, in the reader's own clock.
 *
 * The ledger's day is a **UTC** date, so this is not midnight where anybody
 * reading it lives — in Lima it is 19:00, and a strip that said "midnight"
 * would be wrong by five hours in the direction that matters. The instant comes
 * off the wire for exactly that reason and is put into the reader's zone here.
 *
 * Null for anything that will not parse. `new Date('nonsense')` formats as
 * `Invalid Date`, and printing those two words on a page about whether the
 * collector is healthy is precisely the invented fallback 12.234 forbids.
 */
export function formatReset(resetsAt: string): string | null {
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
