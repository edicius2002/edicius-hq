import { formatFlightDate, formatFlightMonth } from '@/features/airfare/data/fareRoutes';
import {
  bucketKey,
  summarise,
  type Bucket,
  type Granularity,
} from '@/features/airfare/lib/buckets';
import { NO_VALUE, formatMoney } from '@/shared/lib/money';
import type { CalendarCurve } from '@/shared/api/fares';

/**
 * A booking horizon, gathered into periods a chart can draw.
 *
 * **This is a fourth meaning of time on this page, and the only one that is a
 * departure *date*.** `bucketSnapshots` groups by when we looked, `leadSnapshots`
 * by how long before the flight, the scatter plots when the plane leaves; this
 * groups by *which departure date you would buy*, across every month at once.
 * Nothing here touches `capturedAt` except to report it — the curve states its own window
 * and the domain comes from the row, so a curve collected yesterday still
 * draws the eleven months it actually priced rather than sliding a day.
 *
 * The two absences of 12.154 survive the trip. A date inside the window
 * carrying `null` is a day the provider answered about and had nothing to sell.
 * A date missing from the row is a day no answer ever came back for. Neither is
 * a zero, and neither may be joined by a line — a fare nobody quoted drawn as a
 * price is worse than a gap.
 */

/** One period of the horizon: the departure dates inside it, and what they cost. */
export type CalendarPeriod = {
  /** `2026-08-19`, `2026-W34`, `2026-08` — sortable as a string in all three. */
  key: string;
  /** What to print on the axis and on the crosshair's tag. */
  label: string;
  /** First departure date this period covers, clipped to the curve's window. */
  from: string;
  /** Last departure date this period covers, clipped to the curve's window. */
  to: string;
  /**
   * The cheapest and dearest departure date inside, and the middle of them —
   * an ordinary `Bucket`, built by `buckets.summarise`.
   *
   * The same five numbers the other charts are drawn from, so `spanOf` and
   * `contiguousRuns` take these unchanged and nothing here re-derives a median.
   * Its `count` is how many departure dates inside carried a price. Null where
   * none did: a hole, whose two possible reasons are counted below. At `day`
   * low, high and middle are one number, because a calendar curve is one price
   * per departure date by construction.
   */
  bucket: Bucket | null;
  /** Dates inside the provider answered about and had nothing to sell. */
  unsold: number;
  /** Dates inside the window that never came back with an answer. */
  unanswered: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every calendar date from one to another, inclusive.
 *
 * `Date.UTC` on the split parts throughout, never `new Date('2026-08-19')`:
 * the latter is midnight UTC and reads as the 18th for this app's default
 * reader in Lima, which would shift the whole horizon by a day and put every
 * price on the wrong departure.
 */
export function eachDate(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const dates: string[] = [];
  for (let at = start; at <= end; at += DAY_MS) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * How a period is written on this axis.
 *
 * Not `buckets.labelFor`, and the difference is the point rather than an
 * oversight. That one writes a day as `MM-DD` because "the year is on the axis,
 * not on every tick" — true of an archive a few weeks long, false of a horizon
 * that runs from August into the following July, where `01-15` names two
 * different days. And a month here is a *departure* month, which 12.114 says is
 * written `March 2027` precisely so it cannot be read as `03/2027`. The week
 * form is taken from `buckets` unchanged, so a week means the same stretch on
 * every chart this page draws.
 */
export function periodLabel(key: string, granularity: Granularity): string {
  if (granularity === 'month') return formatFlightMonth(key);
  if (granularity === 'week') return key.replace('-W', ' wk ');
  return formatFlightDate(key);
}

/**
 * The departure dates a period actually covers, in words.
 *
 * Built from the dates walked rather than from `periodBounds`, and the reason
 * is the window. The first and last periods of a horizon are partial — a curve
 * starting on the 19th of August covers eleven days of that month, not
 * thirty-one — so naming the whole calendar unit would claim eighteen days
 * nobody has a price for. `periodBounds` is right for the history chart, where
 * the claim being made *is* about the whole unit; here the stated range and the
 * counted set are the same set only if the window does the clipping.
 *
 * No clock either. `00:00 to 23:59` belongs on an observation stamp; a
 * departure date is a date, and a time of day on it would suggest the fare
 * moved during it.
 */
export function departureRange(period: CalendarPeriod): string {
  if (period.from === period.to) return `departing ${formatFlightDate(period.from)}`;
  return `departing ${formatFlightDate(period.from)} to ${formatFlightDate(period.to)}`;
}

/**
 * The collection stamp as written, never reparsed.
 *
 * `capturedAt` is an instant with an offset, and the rest of this feature reads
 * such stamps by slicing rather than by `new Date`, so a reader west of
 * Greenwich is not shown the previous day. Slicing keeps the stamp's own clock,
 * which is the one the collector wrote. It matters more here than on the other
 * charts: a curve is written only when something moved, so the one on screen
 * may be weeks old and the reader has to be able to see that.
 */
export function collectedAtLabel(capturedAt: string): string {
  const day = capturedAt.slice(0, 10);
  const clock = capturedAt.slice(11, 16);
  return /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? `${formatFlightDate(day)}${/^\d{2}:\d{2}$/.test(clock) ? ` ${clock}` : ''}`
    : capturedAt;
}

/**
 * The curve, period by period, across the window it states.
 *
 * Every period between `fromDate` and `toDate` is emitted, including the ones
 * holding nothing. That is what keeps the horizontal axis a calendar: dropping
 * an empty period would close the gap and slide every later departure date
 * leftwards onto a day it does not belong to.
 *
 * Dates outside the stated window are ignored rather than trusted. A row whose
 * prices reach past its own `to` is a row that disagrees with itself, and the
 * window is the half that says which dates were asked about.
 */
export function calendarPeriods(
  curve: CalendarCurve | null,
  granularity: Granularity,
): CalendarPeriod[] {
  if (curve === null) return [];

  const priceByDate = new Map<string, number | null>();
  for (const point of curve.prices) priceByDate.set(point.departureDate, point.price);

  const groups = new Map<
    string,
    { from: string; to: string; prices: number[]; unsold: number; unanswered: number }
  >();

  for (const date of eachDate(curve.fromDate, curve.toDate)) {
    const key = bucketKey(date, granularity);
    let group = groups.get(key);
    if (!group) {
      group = { from: date, to: date, prices: [], unsold: 0, unanswered: 0 };
      groups.set(key, group);
    }
    group.to = date;

    if (!priceByDate.has(date)) group.unanswered += 1;
    else {
      const price = priceByDate.get(date) ?? null;
      if (price === null) group.unsold += 1;
      else group.prices.push(price);
    }
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => {
      const label = periodLabel(key, granularity);
      return {
        key,
        label,
        from: group.from,
        to: group.to,
        // `buckets.summarise` rather than four lines of min, max and median.
        // A band and a middle is the same measurement whichever axis it lands
        // on, which is exactly why 12.170 exported it — and it keeps this
        // chart's middle a median, so one glitched date cannot drag a month's
        // with it.
        bucket: group.prices.length === 0 ? null : summarise(key, label, group.prices),
        unsold: group.unsold,
        unanswered: group.unanswered,
      };
    });
}

/** Every key on the axis, holes included — what `contiguousRuns` measures against. */
export function calendarKeys(periods: CalendarPeriod[]): string[] {
  return periods.map((period) => period.key);
}

/** The priced periods as plain buckets, for `spanOf` and `contiguousRuns`. */
export function calendarBuckets(periods: CalendarPeriod[]): Bucket[] {
  return periods.flatMap((period) => (period.bucket ? [period.bucket] : []));
}

/* ------------------------------------------------------------ the read-out -- */

/**
 * What the crosshair says about one period.
 *
 * Deliberately not `crosshair.readingAt`. That one describes a band, a median
 * and *a provider baseline* — two series over the same observation stamps, one
 * of which is context for the other. A calendar curve is a single series and
 * has no baseline behind it, so the field would be a permanent `—`; and the
 * fact it does have to report — how many of a period's departure dates were
 * priced, how many had nothing on sale, and how many were never answered for —
 * has nowhere to go in that shape. The geometry of `lib/crosshair.ts` is shared
 * to the last unit; its meaning is not transferable, which is the same split
 * 12.144 made for the scatter.
 */
export type CalendarReading = {
  key: string;
  label: string;
  /** The departure dates covered, spelled out. */
  range: string;
  /** The band and its median, or null where nothing inside was priced. */
  band: Bucket | null;
  /** Departure dates inside that carried a price — the band's own `count`. */
  priced: number;
  unsold: number;
  unanswered: number;
  /** How many departure dates the period covers at all. */
  days: number;
};

export function calendarReading(period: CalendarPeriod): CalendarReading {
  const priced = period.bucket?.count ?? 0;
  return {
    key: period.key,
    label: period.label,
    range: departureRange(period),
    band: period.bucket,
    priced,
    unsold: period.unsold,
    unanswered: period.unanswered,
    days: priced + period.unsold + period.unanswered,
  };
}

/**
 * The two absences, in words, and never the same words.
 *
 * This is the sentence 12.154 exists for. "Nothing on sale" is a fact about the
 * world that the provider stated; "no answer collected" is a fact about us. A
 * reader who is told the first when the second is true will believe a route is
 * sold out on a day nobody has ever asked about.
 */
export function absenceNote(reading: CalendarReading): string | null {
  const parts: string[] = [];
  if (reading.unsold > 0) {
    parts.push(
      reading.unsold === 1 && reading.days === 1
        ? 'nothing on sale'
        : `${reading.unsold} day${reading.unsold === 1 ? '' : 's'} with nothing on sale`,
    );
  }
  if (reading.unanswered > 0) {
    parts.push(
      reading.unanswered === 1 && reading.days === 1
        ? 'no answer collected'
        : `${reading.unanswered} day${reading.unanswered === 1 ? '' : 's'} never answered for`,
    );
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The reading as a sentence, for the live region.
 *
 * Same contract as `readingSentence`: prose rather than a grid, every figure
 * through `shared/lib/money`, and an absence named rather than dropped. A
 * single date says one price and not a range of one, because "$62.94 to $62.94,
 * median $62.94" is three ways of saying a number nobody asked to hear thrice.
 *
 * At `day` the label already *is* the departure date, so the range is dropped
 * rather than repeated — "24/12/2026, departing 24/12/2026" is the same fact
 * twice, and a live region that says everything twice is one nobody listens to.
 * At a week or a month the two say different things and both stay.
 */
export function rangeRepeatsLabel(reading: CalendarReading): boolean {
  return reading.range === `departing ${reading.label}`;
}

export function calendarSentence(reading: CalendarReading, currency: string): string {
  const parts = rangeRepeatsLabel(reading)
    ? [reading.range]
    : [`${reading.label}, ${reading.range}`];

  if (reading.band === null) {
    parts.push(`no fare ${NO_VALUE}`);
  } else if (reading.priced === 1) {
    parts.push(`cheapest fare ${formatMoney(reading.band.middle, currency)}`);
  } else {
    parts.push(
      `cheapest fare ${formatMoney(reading.band.low, currency)} to ${formatMoney(reading.band.high, currency)}, median ${formatMoney(reading.band.middle, currency)}, across ${reading.priced} departure date${reading.priced === 1 ? '' : 's'}`,
    );
  }

  const absence = absenceNote(reading);
  if (absence) parts.push(absence);

  return `${parts.join('. ')}.`;
}
