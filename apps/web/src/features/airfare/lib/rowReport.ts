import { formatFlightDate, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import type {
  CalendarCollectResponse,
  CollectResponse,
  CollectRouteResult,
} from '@/shared/api/fares';
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

/**
 * Whether a result belongs to one of the months the pass in hand is covering.
 *
 * The months are the **pass's**, never the route's whole set: a month this row
 * watches that this pass was not asked about is not this pass's business, and
 * counting its departures would let one row's sentence describe another's work.
 * They are not the open tab either — a report says what the pass did, and
 * narrowing it to whichever month the reader happens to be looking at would
 * make one press produce different sentences depending on where they stood.
 */
function isOurResult(
  result: CollectRouteResult,
  route: FareRoute,
  months: readonly string[],
): boolean {
  return (
    result.origin === route.origin &&
    result.destination === route.destination &&
    months.some((month) => result.flightDate.startsWith(month))
  );
}

/**
 * How the collector names one month of this watch: `ARI-SCL 2027-03`.
 *
 * `CollectionPass.watching` carries one of these per watched month, and
 * `CollectionReport.skipped` carries `f"{origin}-{destination} {flight_date}"`
 * — sentences for a human, not keys — so matching either means rebuilding the
 * string here. Kept in one function so the coupling is in one place and
 * findable from either end.
 */
function watchName(route: FareRoute, month: string): string {
  return `${route.origin}-${route.destination} ${month}`;
}

/**
 * The months of this watch the pass in hand is actually covering.
 *
 * Exported because every other reading takes it rather than asking again:
 * `describeCollection`, `describeProgress`, `passProgress` and `collectNotice`
 * all have to agree about whose pass this is and which of its months are ours,
 * and four independent readings of `watching` are four chances to disagree.
 */
export function passMonths(route: FareRoute, response: CollectResponse): string[] {
  return route.months.filter((month) => response.watching.includes(watchName(route, month)));
}

/**
 * The reasons these months' departures were passed over, commonest first.
 *
 * Grouped rather than listed for the same reason the command-line pass groups
 * them: on a daily cadence a healthy press skips thirty of thirty-one, and a
 * line naming each one would bury the one that matters. With several months it
 * would bury it under ninety.
 */
function skipSummary(
  route: FareRoute,
  months: readonly string[],
  response: CollectResponse,
): string {
  const counts = new Map<string, number>();
  const prefixes = months.map((month) => watchName(route, month));
  for (const entry of response.skipped) {
    if (!prefixes.some((prefix) => entry.what.startsWith(prefix))) continue;
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
 *
 * Exported for `passProgress`, which has to answer the same question before it
 * draws anything and must answer it the same way. Two readings of `watching`
 * would let the words and the bar on one row disagree about whose pass they are
 * describing, which is the same lie arriving twice.
 *
 * **Any of our months, not all of them** —
 * `a-pass-is-ours-if-it-names-any-of-our-months`. A press sends every month
 * that can still be collected, so the two rules agree on it — until the row
 * holds a month that has departed and was never sent, or the reader edits the
 * chips while the pass is in flight. All-of-mine would then answer *false*
 * about the row's own press, and the row would report its own collection as a
 * stranger's: the same quiet lie this function exists to prevent, arriving
 * from the opposite direction. A scheduled pass names the whole watchlist, so
 * both rules say yes; another row's press names another pair, so both say no.
 * The only pass that can tell them apart is one naming *some* of our months,
 * and every way to produce one is a pass this row started.
 *
 * What pair identity removed: two rows can no longer share a month name,
 * because a pair is one row.
 */
export function isOurPass(route: FareRoute, response: CollectResponse): boolean {
  return passMonths(route, response).length > 0;
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
  // Read once and threaded down, so nothing below re-asks whose pass this is.
  const months = passMonths(route, response);
  if (months.length === 0) return notOurPass(response);
  // The pass fell over as a whole, which is a different fact from every route
  // in it being refused and has to read as one — 12.210.
  if (response.state === 'failed') {
    return { ok: false, text: `The pass failed: ${response.error ?? 'no reason given'}` };
  }

  const results = response.results.filter((candidate) => isOurResult(candidate, route, months));
  const skipped = skipSummary(route, months, response);

  if (results.length === 0) {
    if (skipped) return { ok: false, text: `Not collected: ${skipped}.` };
    // "this watch" rather than "this month": a row is several months now, and
    // a sentence that had to enumerate which is a sentence nobody reads — the
    // call `skipSummary` already makes for reasons.
    return { ok: false, text: 'The pass came back without a word about this watch.' };
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

/**
 * What the horizon collection fired by adding a route came back with — 12.247.
 *
 * Its own function rather than a branch of `describeCollection`, because the
 * two report different work: that one summarises up to thirty-one boards for
 * one month, this one reports a single curve across every month. Sharing a
 * sentence would mean one of them describing itself in the other's units.
 *
 * **Every branch ends with the route still being watched**, and that is the
 * decision rather than the wording. Adding a route is a write to the reader's
 * own document; collecting its horizon is a request to somebody else's server.
 * A form that refused to save because a fare lookup failed would let an
 * upstream veto a watchlist edit, so the collection is reported and never
 * rolled back into.
 */
/**
 * How the collector names a city pair. A horizon covers every month at once,
 * so unlike `skipPrefix` there is no departure in it.
 */
function pairOf(route: FareRoute): string {
  return `${route.origin}-${route.destination}`;
}

/**
 * Whether the horizon pass in hand is the one this row asked for.
 *
 * `isOurPass`'s twin, and separate for the reason those two passes are
 * separate everywhere else: that one matches a route *and a month*, because a
 * board pass is a month's worth of departures. A curve is a fact about the city
 * pair alone, so this matches on the pair and would be wrong if it did more.
 *
 * Exported for `horizonProgress`, which has to answer the same question before
 * it draws a bar and must answer it the same way — the identical argument
 * `isOurPass` makes: two readings of `watching` would let the words and the bar
 * on one row disagree about whose pass they are describing.
 */
export function isOurHorizonPass(route: FareRoute, response: CalendarCollectResponse): boolean {
  return response.watching.includes(pairOf(route));
}

/**
 * A horizon pass that is still going, counted rather than described.
 *
 * **What this replaces was a promise, and the promise was false.** The row used
 * to say "two requests, about four seconds" once and then hold that sentence,
 * unchanged, until the pass ended. Measured live on 2026-08-21 the pass was
 * three requests and twenty seconds — the provider refused a far window and the
 * collector walked it back, which is 12.245 working — so the reader was told a
 * figure five times under what they then sat through, by a line that never
 * moved to suggest otherwise.
 *
 * **It counts windows and requests, not departures.** A horizon pass polls no
 * departures at all, so `describeProgress`'s units would have been borrowed and
 * meaningless here. The two figures are both reported because they come apart:
 * a refused far end is asked for again, so three requests can buy two windows,
 * and a reader who can see that is watching a retry rather than a machine that
 * has stopped.
 */
export function describeHorizonProgress(
  route: FareRoute,
  response: CalendarCollectResponse,
): RowReport {
  if (!isOurHorizonPass(route, response)) return notOurHorizonPass(response);

  const label = routeLabel(route);
  // The plan has not settled. The server decides which windows it means to
  // price before it sends anything, so this is the first instant or two only —
  // and a count of zero out of nothing would be worse than saying less.
  if (response.windows === null) {
    return { ok: true, text: `Collecting the booking horizon for ${label}…` };
  }

  const windows = `${response.windowsPriced} of ${response.windows} window${
    response.windows === 1 ? '' : 's'
  } priced`;
  const requests = `${response.requests} request${response.requests === 1 ? '' : 's'}`;
  // A pass that has priced nothing yet has no dates, and "0 departure dates" is
  // a figure where "none yet" is the fact.
  const dates =
    response.dates === 0
      ? 'no departure dates yet'
      : `${response.dates} departure date${response.dates === 1 ? '' : 's'} so far`;

  return { ok: true, text: `Collecting ${label}: ${windows} in ${requests}, ${dates}.` };
}

/** What a row says about a horizon pass that belongs to some other route. */
function notOurHorizonPass(response: CalendarCollectResponse): RowReport {
  const others = response.watching.join(', ') || 'another route';
  return {
    ok: false,
    text: `A booking horizon collection for ${others} is already running; this route is watched and its horizon will need a pass of its own.`,
  };
}

export function describeHorizon(route: FareRoute, response: CalendarCollectResponse): RowReport {
  const pair = pairOf(route);
  if (!isOurHorizonPass(route, response)) return notOurHorizonPass(response);
  if (response.state === 'failed') {
    return {
      ok: false,
      text: `The booking horizon pass failed: ${response.error ?? 'no reason given'}. The route is watched either way.`,
    };
  }

  const skipped = response.skipped.filter((entry) => entry.what === pair);
  const result = response.results.find(
    (candidate) => `${candidate.origin}-${candidate.destination}` === pair,
  );

  if (!result) {
    // Not-due is the ordinary way to arrive here: a pair collected earlier
    // today already has the curve this pass would have fetched, and spending
    // two requests to rewrite it is the thing the cadence exists to refuse.
    if (skipped.length > 0) {
      return {
        ok: true,
        text: `Booking horizon not collected again — ${skipped[0].reason}. The one on disk already covers this route.`,
      };
    }
    return {
      ok: false,
      text: 'The horizon pass came back without a word about this route. It is watched all the same.',
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      text: `Booking horizon refused: ${result.errorCode ?? 'unknown'} — ${result.errorMessage ?? 'no reason given'}. The route is watched; the chart says the horizon is not collected yet.`,
    };
  }

  return {
    ok: true,
    text: `Booking horizon collected: ${result.priced} of ${result.dates} departure date${result.dates === 1 ? '' : 's'} priced in ${result.requests} request${result.requests === 1 ? '' : 's'}.`,
  };
}

/** The request itself never landed — a timeout, a dead API, a 500. */
export function describeRefusal(message: string): RowReport {
  return { ok: false, text: `The call failed: ${message}` };
}
