import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * Turning an archive into something you can read.
 *
 * Pure, and tested without a browser. Nothing here fetches, formats or renders;
 * the numbers it produces are the same numbers the chart draws and the table
 * summarises, so the two can never disagree about what the cheapest fare was.
 */

export type PricePoint = {
  /** When the price was observed. */
  capturedAt: string;
  price: number;
  currency: string;
};

export type PriceStats = {
  latest: number;
  lowest: number;
  highest: number;
  median: number;
  /**
   * Today's price against the median of everything observed. Negative is a
   * fare below its own history, which is the question the page exists to
   * answer — `null` until there is more than one observation to compare with.
   */
  deltaVsMedian: number | null;
  observations: number;
};

export type AirlineSummary = {
  airline: string;
  airlineName: string | null;
  cheapest: number;
  offers: number;
};

/**
 * The snapshots that belong to one watched month.
 *
 * The archive keys by city pair, so one file holds every departure ever
 * watched for LIM-SCL. Showing them all together would put an October fare and
 * a December fare in front of the reader as one thing, and the step between
 * them would read as a price movement.
 *
 * A month is a prefix of a `YYYY-MM-DD` departure, which is why this is a
 * string comparison rather than any date arithmetic — the same property the
 * server's own `departure` filter leans on. The thirty-one departures inside
 * the month deliberately stay together: they are the question the watch is now
 * asking, and separating them again is the caller's business.
 */
export function snapshotsFor(snapshots: FareSnapshot[], month: string): FareSnapshot[] {
  return snapshots.filter((snapshot) => snapshot.flightDate.startsWith(month));
}

export function cheapestOffer(snapshot: FareSnapshot): FareOffer | null {
  return snapshot.offers.reduce<FareOffer | null>(
    (best, offer) => (best === null || offer.price < best.price ? offer : best),
    null,
  );
}

/**
 * One point per observation: the cheapest fare available that day.
 *
 * A snapshot with no offers contributes nothing rather than a zero. Zero is a
 * price, and a chart would draw it as the best deal ever found.
 */
export function cheapestSeries(snapshots: FareSnapshot[]): PricePoint[] {
  const points: PricePoint[] = [];
  for (const snapshot of snapshots) {
    const offer = cheapestOffer(snapshot);
    if (!offer) continue;
    points.push({
      capturedAt: snapshot.capturedAt,
      price: offer.price,
      currency: offer.currency || snapshot.currency,
    });
  }
  return points.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function priceStats(points: PricePoint[]): PriceStats | null {
  if (points.length === 0) return null;

  const prices = points.map((point) => point.price);
  const latest = points[points.length - 1].price;
  const middle = median(prices);

  return {
    latest,
    lowest: Math.min(...prices),
    highest: Math.max(...prices),
    median: middle,
    // One observation is its own median, so the comparison would always read
    // zero — a confident "right on average" from a single data point.
    deltaVsMedian: points.length > 1 ? latest - middle : null,
    observations: points.length,
  };
}

/** Cheapest fare per carrier in one snapshot, cheapest carrier first. */
export function byAirline(snapshot: FareSnapshot | null): AirlineSummary[] {
  if (!snapshot) return [];

  const grouped = new Map<string, AirlineSummary>();
  for (const offer of snapshot.offers) {
    const existing = grouped.get(offer.airline);
    if (!existing) {
      grouped.set(offer.airline, {
        airline: offer.airline,
        airlineName: offer.airlineName,
        cheapest: offer.price,
        offers: 1,
      });
      continue;
    }
    existing.offers += 1;
    if (offer.price < existing.cheapest) existing.cheapest = offer.price;
  }

  return [...grouped.values()].sort((a, b) => a.cheapest - b.cheapest);
}

/**
 * The most recent look at each departure, one per day of the month.
 *
 * A watched month holds thirty-one series in one file, and they are polled one
 * at a time — so the newest snapshot overall belongs to whichever departure the
 * collector happened to reach last, which is a fact about the pacing and not
 * about the fares. Reducing per departure first is what turns "the last thing
 * we saw" into "what the month looks like now".
 */
export function latestPerDeparture(snapshots: FareSnapshot[]): FareSnapshot[] {
  const newest = new Map<string, FareSnapshot>();
  for (const snapshot of snapshots) {
    const held = newest.get(snapshot.flightDate);
    if (!held || snapshot.capturedAt > held.capturedAt) newest.set(snapshot.flightDate, snapshot);
  }
  return [...newest.values()].sort((a, b) => a.flightDate.localeCompare(b.flightDate));
}

/**
 * The day of the month the fare is lowest on, as that day was last seen.
 *
 * This is the answer a month watch exists to give, and it is the board the
 * detail panel shows: "March costs $210 and it is the 9th that costs it" is
 * the sentence, where a single watched departure could only ever have said the
 * first half.
 *
 * A snapshot with no offers cannot win — a board with nothing on it is not the
 * cheapest way to fly, it is a day with no flights.
 */
export function cheapestDeparture(snapshots: FareSnapshot[]): FareSnapshot | null {
  let best: FareSnapshot | null = null;
  let bestPrice = Number.POSITIVE_INFINITY;
  for (const snapshot of latestPerDeparture(snapshots)) {
    const offer = cheapestOffer(snapshot);
    if (!offer || offer.price >= bestPrice) continue;
    best = snapshot;
    bestPrice = offer.price;
  }
  return best;
}

/**
 * The clock part of an ISO stamp that carries no zone.
 *
 * `departureAt` is wall clock at the airport with no offset, so it must never
 * go through `Date`: the browser would read it in its own zone and move a
 * 00:15 departure by however many hours the reader happens to be from Lima.
 */
export function departureClock(iso: string): string {
  const time = iso.split('T')[1];
  return time ? time.slice(0, 5) : '';
}

export function departureDay(iso: string): string {
  return iso.split('T')[0] ?? '';
}

/**
 * When something was observed, written the way this reader writes a date.
 *
 * `18/08/2026 19:45`, to match the dates in the watchlist — the same view was
 * showing `17/10/2026` beside `2026-08-18 19:45`, which is two conventions for
 * the same kind of thing. A string split rather than a `Date` for the reason
 * above it: this stamp is wall clock and must not be shifted into the reader's
 * own zone.
 */
export function formatStamp(iso: string): string {
  const [date, time] = iso.split('T');
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!parts) return iso;
  const [, year, month, day] = parts;
  const clock = time ? ` ${time.slice(0, 5)}` : '';
  return `${day}/${month}/${year}${clock}`;
}

/** `215` → `3h 35m`, which is how long a flight is actually described. */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** How many days before departure an observation was made. */
export function daysBeforeDeparture(capturedAt: string, flightDate: string): number | null {
  const captured = Date.parse(`${capturedAt.slice(0, 10)}T00:00:00Z`);
  const departure = Date.parse(`${flightDate}T00:00:00Z`);
  if (Number.isNaN(captured) || Number.isNaN(departure)) return null;
  return Math.round((departure - captured) / 86_400_000);
}
