import { type FareRoute } from '@/features/airfare/data/fareRoutes';
import type { CollectResponse, CollectRouteResult } from '@/shared/api/fares';
import { formatMoney } from '@/shared/lib/money';

/**
 * What one press of a row's collect control came back with, in a sentence.
 *
 * Pure, and its own module rather than a helper inside `RouteList`, for the
 * reason `lib/buckets` and `lib/series` are separate from the charts that draw
 * them: the wording of a refusal is the part worth pinning in a test, and a
 * test that has to mount a list to read a sentence is testing the list.
 *
 * Every branch here says something. A press that collected nothing must not
 * come back blank — decisions 8.8 and 8.41, the same rule the pass itself
 * follows on the server: what was refused travels beside what worked and says
 * why. A silent control is indistinguishable from a broken one.
 */

export type RowReport = {
  /** Whether the press got what it asked for. The row colours the line by it. */
  ok: boolean;
  text: string;
};

/**
 * Whether a result in the report is the route that was asked about.
 *
 * A row's press carries exactly one route, so there is at most one result to
 * find and the departure date alone would separate it. The pair is compared as
 * well because the cost is three string comparisons and the alternative is a
 * row that would confidently report someone else's outcome if the request ever
 * grew a second route.
 */
function isSameRoute(result: CollectRouteResult, route: FareRoute): boolean {
  return (
    result.origin === route.origin &&
    result.destination === route.destination &&
    result.flightDate === route.flightDate
  );
}

/**
 * How the collector names a departure it decided not to poll.
 *
 * `CollectionReport.skipped` carries `f"{origin}-{destination} {flight_date}"`
 * — a sentence for a human, not a key — so matching it means rebuilding that
 * string here. Kept in one function so the coupling is in one place and
 * findable from either end.
 */
function skipName(route: FareRoute): string {
  return `${route.origin}-${route.destination} ${route.flightDate}`;
}

/**
 * The outcome of a one-route collection pass, for the row that asked for it.
 *
 * The `skipped` branch is not dead code waiting for a bug. `POST
 * /api/fares/collect` calls the collector's unconditional `collect`, never
 * `collect_due`, so a route handed to it is polled whatever the cadence says
 * and today's server can only answer with a result. If that ever changes, the
 * row says "not collected" and why, instead of a press that appears to do
 * nothing — which is the failure mode this whole line of text exists to
 * prevent.
 *
 * `locale` is threaded through for the same reason `money` takes one: the
 * browser's locale is right in the app and unpinnable in a test.
 */
export function describeCollection(
  route: FareRoute,
  response: CollectResponse,
  locale?: string,
): RowReport {
  const result = response.results.find((candidate) => isSameRoute(candidate, route));

  if (result && !result.ok) {
    const code = result.errorCode ?? 'unknown';
    const reason = result.errorMessage ?? 'no reason given';
    return { ok: false, text: `Refused: ${code} — ${reason}` };
  }

  if (result) {
    const flights = `${result.offers} flight${result.offers === 1 ? '' : 's'}`;
    // A look that found the board empty is still a look, and reporting a
    // cheapest of nothing as a price of zero would put a false point in front
    // of the reader.
    const price =
      result.cheapest !== null && result.currency !== null
        ? `cheapest ${formatMoney(result.cheapest, result.currency, locale)}`
        : 'no price quoted';
    // A snapshot is written only when something moved, so most successful
    // looks write nothing — and a reader who is not told that reads an
    // unchanged series as a collector that failed.
    const wrote = result.changed ? 'a new snapshot' : 'nothing new to record';
    const seeded =
      result.seeded > 0 ? `, ${result.seeded} days of the provider's own history seeded` : '';
    return { ok: true, text: `Collected: ${flights}, ${price} — ${wrote}${seeded}.` };
  }

  const skipped = response.skipped.find((entry) => entry.what === skipName(route));
  if (skipped) return { ok: false, text: `Not collected: ${skipped.reason}.` };

  return { ok: false, text: 'The pass came back without a word about this route.' };
}

/** The request itself never landed — a timeout, a dead API, a 500. */
export function describeRefusal(message: string): RowReport {
  return { ok: false, text: `The call failed: ${message}` };
}
