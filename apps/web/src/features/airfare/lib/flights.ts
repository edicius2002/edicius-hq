import { latestPerDeparture } from '@/features/airfare/lib/series';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * Following one flight through the archive, rather than following the cheapest
 * fare on the route.
 *
 * The cheapest-fare line answers "is this route cheaper than it was", and it
 * can move for a reason that has nothing to do with price: a carrier adds a
 * red-eye and the line drops without a single fare changing. Watching flights
 * individually separates the two, and it is the only way to answer the
 * question the watchlist is actually for — *this* departure, on *this*
 * carrier, at *this* hour, has it moved.
 *
 * Identity is `airline + flight number + departure time + arrival time`.
 * Verified against real snapshots on 2026-08-18: 25 of 33 flights kept the
 * first three across a whole day, and every one that did not had genuinely
 * rotated off the board.
 *
 * The arrival is there because the first three name the *first leg*, not the
 * itinerary. A LIM-MAD board captured on 2026-08-19 offers AV 50 to Bogota
 * twice, once continuing on AV 182 and once on AV 10, arriving five hours
 * apart at different prices; without the arrival those two collapse into one
 * row whose price history alternates between two different journeys. A
 * schedule change to the arrival now reads as a new flight, which is the same
 * trade the departure already made and the lesser of the two errors.
 */

/** How a flight is recognised from one observation to the next. */
export function flightKey(offer: FareOffer): string {
  return `${offer.airline}|${offer.flightNumber ?? ''}|${offer.departureAt}|${offer.arrivalAt ?? ''}`;
}

export type FlightObservation = {
  capturedAt: string;
  price: number;
};

export type FlightTrack = {
  key: string;
  airline: string;
  airlineName: string | null;
  flightNumber: string | null;
  departureAt: string;
  transfers: number;
  /** Ordered intermediate airports when this observation retained them. */
  viaPoints?: string[] | null;
  durationMinutes: number | null;
  currency: string;
  /** Every price ever observed for this flight, oldest first. */
  observations: FlightObservation[];
  /** The most recent price. */
  price: number;
  /** The price before the most recent change, or null if it never moved. */
  previousPrice: number | null;
  /** The first price ever observed. */
  firstPrice: number;
  /** Whether the flight was in the most recent observation at all. */
  present: boolean;
};

/**
 * Every flight the archive has ever seen for a route, with its price history.
 *
 * Flights missing from the latest snapshot are kept and marked `present:
 * false` rather than dropped — a flight that disappeared is a fact about the
 * route, and dropping it would make the board look like it never held one.
 *
 * "The latest snapshot" is the latest one *of each departure*, not the latest
 * of all — 12.115. Since 12.110 these snapshots span a whole month of
 * departures polled one at a time, so the newest of them belongs to whichever
 * day the collector happened to reach last; measuring presence against it
 * alone would mark every flight on the other thirty days as gone, on the
 * strength of nothing but the order the pass ran in.
 */
export function trackFlights(snapshots: FareSnapshot[]): FlightTrack[] {
  const ordered = [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const latestKeys = new Set(
    latestPerDeparture(ordered).flatMap((snapshot) => snapshot.offers.map(flightKey)),
  );

  const tracks = new Map<string, FlightTrack>();
  for (const snapshot of ordered) {
    for (const offer of snapshot.offers) {
      const key = flightKey(offer);
      const existing = tracks.get(key);
      const observation = { capturedAt: snapshot.capturedAt, price: offer.price };
      if (existing) {
        // Consecutive identical prices are not observations of a change, and
        // recording them would make "moved twice" indistinguishable from
        // "looked at twice".
        if (existing.observations.at(-1)?.price !== offer.price) {
          existing.observations.push(observation);
        }
        continue;
      }
      tracks.set(key, {
        key,
        airline: offer.airline,
        airlineName: offer.airlineName,
        flightNumber: offer.flightNumber,
        departureAt: offer.departureAt,
        transfers: offer.transfers,
        viaPoints: offer.viaPoints,
        durationMinutes: offer.durationMinutes,
        currency: offer.currency,
        observations: [observation],
        price: offer.price,
        previousPrice: null,
        firstPrice: offer.price,
        present: latestKeys.has(key),
      });
    }
  }

  return [...tracks.values()]
    .map((track) => ({
      ...track,
      price: track.observations.at(-1)?.price ?? track.price,
      previousPrice: track.observations.length > 1 ? track.observations.at(-2)!.price : null,
      firstPrice: track.observations[0]?.price ?? track.price,
    }))
    .sort((a, b) => {
      if (a.present !== b.present) return a.present ? -1 : 1;
      return a.departureAt.localeCompare(b.departureAt);
    });
}

/**
 * Percentage change from one price to another, or null when there is nothing
 * to compare against.
 *
 * Null rather than zero: "did not move" and "has only been seen once" are
 * different facts, and rendering both as 0% would claim a stability nobody
 * observed.
 */
export function variation(from: number | null, to: number): number | null {
  if (from === null || !Number.isFinite(from) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

export type BoardChange = {
  kind: 'appeared' | 'left' | 'moved';
  track: FlightTrack;
  from: number | null;
  to: number | null;
};

/**
 * What changed between the two most recent observations.
 *
 * This is the answer to "what happened since last time" that a chart cannot
 * give: a route whose cheapest fare held steady while three flights moved and
 * two disappeared had a busy day, and the line would show none of it.
 *
 * **One departure's snapshots only.** "The two most recent observations" means
 * something across one departure and nothing across a month of them — 12.110
 * polls each day separately, so the last two snapshots of a watched month are
 * usually two different days, and every flight on one would read as having
 * appeared while every flight on the other had left. Nothing on the page calls
 * this yet; whatever does must narrow to a departure first.
 */
export function changesBetween(snapshots: FareSnapshot[]): BoardChange[] {
  const ordered = [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  if (ordered.length < 2) return [];

  const previous = ordered.at(-2)!;
  const latest = ordered.at(-1)!;
  const before = new Map(previous.offers.map((offer) => [flightKey(offer), offer]));
  const after = new Map(latest.offers.map((offer) => [flightKey(offer), offer]));
  const tracks = new Map(trackFlights(snapshots).map((track) => [track.key, track]));

  const changes: BoardChange[] = [];
  for (const [key, offer] of after) {
    const was = before.get(key);
    const track = tracks.get(key);
    if (!track) continue;
    if (!was) {
      changes.push({ kind: 'appeared', track, from: null, to: offer.price });
    } else if (was.price !== offer.price) {
      changes.push({ kind: 'moved', track, from: was.price, to: offer.price });
    }
  }
  for (const [key, offer] of before) {
    if (after.has(key)) continue;
    const track = tracks.get(key);
    if (track) changes.push({ kind: 'left', track, from: offer.price, to: null });
  }

  // Biggest move first: on a board of thirty flights the eye should land on
  // the one that jumped 30%, not on the alphabetically first carrier.
  return changes.sort((a, b) => {
    const magnitude = (change: BoardChange) =>
      change.from !== null && change.to !== null
        ? Math.abs(variation(change.from, change.to) ?? 0)
        : Number.POSITIVE_INFINITY;
    return magnitude(b) - magnitude(a);
  });
}
