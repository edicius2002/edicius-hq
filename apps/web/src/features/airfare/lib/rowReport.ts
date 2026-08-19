import { formatFlightDate, type FareRoute } from '@/features/airfare/data/fareRoutes';
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
 *
 * Since 12.110 a row is a *month*, so one press comes back with up to
 * thirty-one outcomes and this has to summarise rather than report. The
 * summary counts rather than names: "4 of 31 departures looked at" is the
 * shape of what happened, where thirty-one dates in a paragraph is a wall
 * nobody reads.
 */

export type RowReport = {
  /** Whether the press got what it asked for. The row colours the line by it. */
  ok: boolean;
  text: string;
};

/** Whether a result in the report belongs to the month that was asked about. */
function isSameRoute(result: CollectRouteResult, route: FareRoute): boolean {
  return (
    result.origin === route.origin &&
    result.destination === route.destination &&
    result.flightDate.startsWith(route.month)
  );
}

/**
 * How the collector names a departure it decided not to poll.
 *
 * `CollectionReport.skipped` carries `f"{origin}-{destination} {flight_date}"`
 * — a sentence for a human, not a key — so matching it means rebuilding that
 * prefix here. Kept in one function so the coupling is in one place and
 * findable from either end.
 */
function skipPrefix(route: FareRoute): string {
  return `${route.origin}-${route.destination} ${route.month}`;
}

/**
 * The reasons this month's departures were passed over, commonest first.
 *
 * Grouped rather than listed for the same reason the command-line pass groups
 * them: on a daily cadence a healthy press skips thirty of thirty-one, and a
 * line naming each one would bury the one that matters.
 */
function skipSummary(route: FareRoute, response: CollectResponse): string {
  const counts = new Map<string, number>();
  const prefix = skipPrefix(route);
  for (const entry of response.skipped) {
    if (!entry.what.startsWith(prefix)) continue;
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
}

/**
 * Whether the pass in hand is the one this row asked for.
 *
 * A press that arrives while a pass is running is answered with that pass
 * rather than starting a second one — 12.210, because the collector's gap
 * paces one loop and two would halve it. `watching` is how the row finds out,
 * and a row that reported somebody else's pass as its own would be the
 * quietest lie this control could tell.
 */
function isOurPass(route: FareRoute, response: CollectResponse): boolean {
  return response.watching.includes(skipPrefix(route));
}

/** What the row says about a pass that started somewhere else. */
function notOurPass(response: CollectResponse): RowReport {
  const others = response.watching.join(', ') || 'another month';
  return {
    ok: false,
    text: `A collection of ${others} is already running; this one was not started.`,
  };
}

/**
 * A pass that is still going, counted rather than described — 12.210.
 *
 * The denominator is real: the server settles which departures it means to
 * poll before it sends the first request, precisely so this line does not have
 * to say "some of an unknown number" for the first four minutes.
 */
export function describeProgress(route: FareRoute, response: CollectResponse): RowReport {
  if (!isOurPass(route, response)) return notOurPass(response);
  const total = response.polling;
  const of = total === null ? '' : ` of ${total}`;
  return {
    ok: true,
    text: `Collecting: ${response.completed}${of} departure${total === 1 ? '' : 's'} so far.`,
  };
}

/**
 * The outcome of one month's collection pass, for the row that asked for it.
 *
 * The `skipped` branch stopped being a contingency when 12.111 put the
 * schedule in front of this button: a press now declines the departures whose
 * last look is younger than their own interval, and on a month already
 * collected today that is all of them. Saying so is the whole point — a press
 * that appears to do nothing is the failure mode this line of text exists to
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
  if (!isOurPass(route, response)) return notOurPass(response);
  // The pass fell over as a whole, which is a different fact from every route
  // in it being refused and has to read as one — 12.210.
  if (response.state === 'failed') {
    return { ok: false, text: `The pass failed: ${response.error ?? 'no reason given'}` };
  }

  const results = response.results.filter((candidate) => isSameRoute(candidate, route));
  const skipped = skipSummary(route, response);

  if (results.length === 0) {
    if (skipped) return { ok: false, text: `Not collected: ${skipped}.` };
    return { ok: false, text: 'The pass came back without a word about this month.' };
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length === results.length) {
    // Every departure refused, so the reason is a property of the route rather
    // than of one day of it, and naming the first one names all of them.
    const code = failures[0].errorCode ?? 'unknown';
    const reason = failures[0].errorMessage ?? 'no reason given';
    return { ok: false, text: `Refused: ${code} — ${reason}` };
  }

  const collected = results.filter((result) => result.ok);
  const changed = collected.filter((result) => result.changed).length;
  const seeded = collected.reduce((total, result) => total + result.seeded, 0);

  // The cheapest departure in the month, and which day of it — the one figure
  // a month can give that a single departure could not. Narrowed before the
  // comparison rather than guarded inside it, so the reduce never has to reach
  // for a `!` the type checker would otherwise need.
  const priced = collected.filter(
    (result): result is CollectRouteResult & { cheapest: number; currency: string } =>
      result.cheapest !== null && result.currency !== null,
  );
  const best = priced.reduce<(typeof priced)[number] | null>(
    (lowest, result) => (lowest === null || result.cheapest < lowest.cheapest ? result : lowest),
    null,
  );

  const looked = `${collected.length} departure${collected.length === 1 ? '' : 's'} looked at`;
  // A look that found the board empty is still a look, and reporting a
  // cheapest of nothing as a price of zero would put a false point in front of
  // the reader.
  const price = best
    ? `cheapest ${formatMoney(best.cheapest, best.currency, locale)} on ${formatFlightDate(best.flightDate)}`
    : 'no price quoted';
  // A snapshot is written only when something moved, so most successful looks
  // write nothing — and a reader who is not told that reads an unchanged
  // series as a collector that failed.
  const wrote =
    changed === 0 ? 'nothing new to record' : `${changed} new snapshot${changed === 1 ? '' : 's'}`;
  const seededText = seeded > 0 ? `, ${seeded} days of the provider's own history seeded` : '';
  const failedText =
    failures.length > 0
      ? `, ${failures.length} refused (${failures[0].errorCode ?? 'unknown'})`
      : '';
  const skippedText = skipped ? `, ${skipped}` : '';

  return {
    ok: failures.length === 0,
    text: `Collected: ${looked}, ${price} — ${wrote}${seededText}${failedText}${skippedText}.`,
  };
}

/** The request itself never landed — a timeout, a dead API, a 500. */
export function describeRefusal(message: string): RowReport {
  return { ok: false, text: `The call failed: ${message}` };
}
