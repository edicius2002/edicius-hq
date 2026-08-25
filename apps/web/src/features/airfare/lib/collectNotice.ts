import {
  formatFlightMonths,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { describeCollection, passMonths, type RowReport } from '@/features/airfare/lib/rowReport';
import type { CollectResponse } from '@/shared/api/fares';

/**
 * A finished press, said where the reader is actually looking.
 *
 * Pure, and its own module rather than state shaped inside `useRouteCollection`,
 * for `rowReport`'s reason: the two rules worth pinning here — *which* passes
 * earn a card and what happens when a second one arrives — are decisions, and a
 * test that has to drive a stream and a mutation to read one of them is testing
 * the hook.
 *
 * **The words are borrowed, never rewritten.** `describeCollection` already
 * composes the sentence the row prints, and it is the sentence with a suite
 * behind it. A card carrying its own phrasing of the same pass would be two
 * descriptions of one fact, drifting apart at the first change to either.
 *
 * What the card adds to the row's line is *reach*. A press is minutes long —
 * a month is up to thirty-one departures paced three seconds apart — and by
 * the time it lands the reader has scrolled the watchlist, opened a chart or
 * gone to another window. The line under the row stays and is still the record;
 * this is the part that finds them.
 */

/**
 * How long a card stays before it fades.
 *
 * Ten seconds against a sentence of about twenty-five words — "Collected: 4
 * departures looked at, cheapest $412.00 on 17/10/2026 — nothing new to
 * record." — which is some eight seconds of reading at a comfortable pace,
 * with room for the glance it takes to notice the card arrived at all. It is
 * deliberately not short: nothing is lost when it goes, because the row's line
 * holds the same sentence for as long as the reader wants it.
 *
 * Exported for the stylesheet as well as for the timer. The fade is a CSS
 * animation and its delay has to end where this ends, so the component hands
 * this number down as a custom property rather than a second copy of it being
 * written in the `.css` file, where it would drift.
 */
export const NOTICE_LIFE_MS = 10_000;

/**
 * How many cards the corner will hold at once.
 *
 * A ceiling rather than a routine. One card per row and a press is minutes
 * long, so reaching four takes a deliberate effort — but a stack that grew
 * without a bound would walk off the top of the window, where a card cannot be
 * read at all, and the ones that would go there are the *oldest*. Three is
 * about a third of a short window's height at this font size.
 */
export const MAX_NOTICES = 3;

export type CollectNotice = {
  /**
   * The row this belongs to, which is also the key it replaces itself by.
   *
   * `routeId`, so `forget` can drop a card by the same handle the page already
   * uses to drop the row's report when the route stops being watched.
   */
  id: string;
  /**
   * Which watch just finished, in words.
   *
   * The row's own line needs no such thing — it sits under the route it is
   * about. This one floats clear of the list, so without a name eight watched
   * routes make one anonymous sentence about a price.
   */
  title: string;
  /** The row's report, unchanged. `ok` colours the card exactly as it colours the line. */
  report: RowReport;
};

/**
 * The card a pass earns, or nothing.
 *
 * Two questions, and both are settled elsewhere on purpose.
 *
 * **Has it finished?** A card raised on a running pass would fade long before
 * the pass it announced was over. Progress is the row's job — it has a bar and
 * a line that count up — and this reports outcomes.
 *
 * **Is it ours?** The scheduled collector runs every fifteen minutes with
 * nobody watching, and a press made while a pass is already running is
 * answered with *that* pass rather than served with its own (12.210). Neither
 * is an interruption the reader asked for, and `isOurPass` is the same
 * question `passProgress` and `describeCollection` ask, asked once more here so
 * the three cannot disagree about whose pass this is. A pass that is not ours
 * still gets its line on the row, where somebody who cares can read it.
 *
 * What is deliberately *not* a condition is whether anything changed. A pass
 * that wrote no snapshot raises a card saying so — "nothing new to record" —
 * because "ran and changed nothing" and "did not run" are the two states a
 * reader cannot tell apart, and silence is how they learn to distrust the
 * control. It is 8.8 and 8.41 again, in a second place.
 */
export function collectNotice(
  route: FareRoute,
  response: CollectResponse,
  locale?: string,
): CollectNotice | null {
  if (response.state === 'running' || response.state === 'idle') return null;
  // The months this pass actually covered, which is what the card names. Not
  // every month the watch holds — a press made with a departed chip in the
  // strip never sent it, and a card claiming it collected one would be the
  // card inventing work. Not the open tab either: the card reports a pass.
  const months = passMonths(route, response);
  if (months.length === 0) return null;
  return {
    id: routeId(route),
    title: `${routeLabel(route)} · ${formatFlightMonths(months)}`,
    report: describeCollection(route, response, locale),
  };
}

/**
 * A card added to the corner: one per row, newest last, oldest dropped.
 *
 * **Rows stack, a row replaces itself.** Two rows can be following one pass —
 * the server keeps a single slot and both watch it — so one row's outcome must
 * not swallow the other's. A row's *own* second press is the opposite case: a
 * row has one latest outcome by definition, and a second card for it would be
 * the older one arguing with the newer, which is the fault the row list already
 * avoids by clearing its line the moment a press starts. Replacing also
 * restarts that row's clock, which is what the caller does with the timer, and
 * is the behaviour anyone who has pressed twice expects.
 */
export function withNotice(
  current: readonly CollectNotice[],
  notice: CollectNotice,
): readonly CollectNotice[] {
  const kept = current.filter((card) => card.id !== notice.id);
  return [...kept, notice].slice(-MAX_NOTICES);
}

/**
 * A card taken back out, by the row it belongs to.
 *
 * Returns the array it was given when there was nothing of that row's to
 * remove. This answer is React state, so a fresh array for a dismissal that
 * matched nothing is a re-render of the page for no change — and the timers
 * that call this fire on rows that may already have gone.
 */
export function withoutNotice(
  current: readonly CollectNotice[],
  id: string,
): readonly CollectNotice[] {
  const kept = current.filter((card) => card.id !== id);
  return kept.length === current.length ? current : kept;
}
