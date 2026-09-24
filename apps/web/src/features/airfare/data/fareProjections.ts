import type { Bucket, UnsoldPeriod } from '@/features/airfare/lib/buckets';
import {
  CHANGE_ORDER,
  departureHour,
  type Facets,
  type FlightRow,
} from '@/features/airfare/lib/flightTable';
import type { FareOffer, FarePairReference, FareSnapshot, WatchHealth } from '@/shared/api/fares';

export type FareMonthProjection = {
  origin: string;
  destination: string;
  month: string;
  revision: string;
  latestCapture: string | null;
  priceDays: Bucket[];
  providerDays: Bucket[];
  unsoldDays: UnsoldPeriod[];
  latestBoards: FareSnapshot[];
  viaSequences: string[][];
  /** Only populated by the historical fallback and never by the projection RPC. */
  archiveSnapshots?: FareSnapshot[];
  health: WatchHealth;
  pairReference: FarePairReference | null;
};

export type FareFlightPage = {
  revision: string;
  latestCapture: string | null;
  tracked: number;
  inPeriod: number;
  shown: number;
  page: number;
  pageCount: number;
  rows: FlightRow[];
  facets: Facets;
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Airfare projection response.');
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid Airfare projection response.');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Airfare projection response.');
  return value;
}

function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid Airfare projection response.');
  return value;
}

function dayBucket(value: unknown): Bucket {
  const row = record(value);
  const key = text(row.key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Invalid Airfare projection day.');
  return {
    key,
    label: key.slice(5),
    low: finite(row.low),
    high: finite(row.high),
    middle: finite(row.middle),
    count: finite(row.count),
  };
}

export function parseFareMonthProjection(
  value: unknown,
  origin: string,
  destination: string,
  month: string,
): FareMonthProjection {
  const body = record(value);
  if (body.origin !== origin || body.destination !== destination || body.month !== month) {
    throw new Error('Airfare projection route mismatch.');
  }
  const health = record(body.health);
  const reference = body.pairReference === null ? null : record(body.pairReference);
  const latestBoards = items(body.latestBoards).map((value) => {
    const board = record(value);
    if (
      board.origin !== origin ||
      board.destination !== destination ||
      !text(board.flightDate).startsWith(month) ||
      !Array.isArray(board.offers)
    ) {
      throw new Error('Invalid Airfare projection board.');
    }
    return board as FareSnapshot;
  });
  return {
    origin,
    destination,
    month,
    revision: text(body.revision),
    latestCapture: body.latestCapture === null ? null : text(body.latestCapture),
    priceDays: items(body.priceDays).map(dayBucket),
    providerDays: items(body.providerDays).map(dayBucket),
    unsoldDays: items(body.unsoldDays).map((value) => {
      const day = record(value);
      const key = text(day.key);
      return { key, label: key.slice(5), count: finite(day.count) };
    }),
    latestBoards,
    viaSequences: items(body.viaSequences).map((value) => items(value).map(text)),
    health: {
      lastCheckedAt: health.lastCheckedAt === null ? null : text(health.lastCheckedAt),
      checks: finite(health.checks),
      changes: finite(health.changes),
      errors: finite(health.errors),
    },
    pairReference:
      reference === null
        ? null
        : {
            value: finite(reference.value),
            dates: finite(reference.dates),
          },
  };
}

export function parseFareFlightPage(value: unknown): FareFlightPage {
  const body = record(value);
  const facets = record(body.facets);
  return {
    revision: text(body.revision),
    latestCapture: body.latestCapture === null ? null : text(body.latestCapture),
    tracked: finite(body.tracked),
    inPeriod: finite(body.inPeriod),
    shown: finite(body.shown),
    page: finite(body.page),
    pageCount: finite(body.pageCount),
    facets: {
      airlines: items(facets.airlines).map((value) => {
        const airline = record(value);
        return { value: text(airline.value), label: text(airline.label) };
      }),
      price:
        facets.price === null
          ? null
          : {
              low: finite(record(facets.price).low),
              high: finite(record(facets.price).high),
            },
      bands: items(facets.bands) as Facets['bands'],
      stops: items(facets.stops).map(finite),
      durations: items(facets.durations).map(finite),
      categories: CHANGE_ORDER.filter((category) => items(facets.categories).includes(category)),
    },
    rows: items(body.rows).map((value) => {
      const row = record(value);
      const offer = record(row.offer) as FareOffer;
      const price = finite(row.price);
      const previousPrice = row.previousPrice === null ? null : finite(row.previousPrice);
      const firstPrice = finite(row.firstPrice);
      return {
        track: {
          key: text(row.key),
          airline: text(offer.airline),
          airlineName: offer.airlineName,
          flightNumber: offer.flightNumber,
          departureAt: text(offer.departureAt),
          transfers: finite(offer.transfers),
          viaPoints: offer.viaPoints,
          durationMinutes: offer.durationMinutes,
          currency: text(offer.currency),
          observations: [],
          price,
          previousPrice,
          firstPrice,
          present: row.present === true,
        },
        category: row.category as FlightRow['category'],
        change: row.change === null ? null : finite(row.change),
        hour: departureHour(offer.departureAt),
      };
    }),
  };
}
