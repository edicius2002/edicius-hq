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
 * The snapshots that belong to one watched route.
 *
 * The archive keys by city pair, so one file holds every departure date ever
 * watched for LIM-SCL. Charting them together would draw an October fare and a
 * December fare as one line and call the step between them a price movement.
 */
export function snapshotsFor(
  snapshots: FareSnapshot[],
  flightDate: string,
  returnDate: string | null = null,
): FareSnapshot[] {
  return snapshots.filter(
    (snapshot) =>
      snapshot.flightDate === flightDate && (snapshot.returnDate ?? null) === returnDate,
  );
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

export function latestSnapshot(snapshots: FareSnapshot[]): FareSnapshot | null {
  return snapshots.reduce<FareSnapshot | null>(
    (latest, snapshot) =>
      latest === null || snapshot.capturedAt > latest.capturedAt ? snapshot : latest,
    null,
  );
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
