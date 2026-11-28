import { plannedRequests } from '@/features/airfare/data/fareRoutes';

/**
 * What watching these months costs one collection pass, in requests and in
 * minutes.
 *
 * The reader was given a strip with no limit on it, so this is the feedback
 * that replaces one. It exists because the expensive thing about a month is not
 * a number anyone sees by default: a month is thirty-one board requests, a pass
 * paces them three seconds apart, and the consequence of a long pass is
 * invisible by construction.
 */

/**
 * The pace one pass runs at, in seconds between requests.
 *
 * Copied across the boundary rather than fetched, the way
 * `COLLECTABLE_HORIZON_DAYS` is (12.184) and with the same caveat stated: the
 * server's own default is `DEFAULT_REQUEST_GAP_SECONDS = 3.0`, and it is
 * overridable at runtime by `FARES_REQUEST_GAP_SECONDS` — the scheduled task
 * sets 1.75. So this number is right for a browser press and can be wrong for a
 * scheduled pass, which is why every sentence built on it says "about".
 */
export const REQUEST_GAP_SECONDS = 3;

/**
 * How long a pass has before it costs the collector its next scheduled run.
 *
 * The scheduled task fires every fifteen minutes with `MultipleInstances =
 * IgnoreNew`, so a *scheduled* pass that overruns makes the following firing
 * disappear — no error, no log, and no missing data that looks like anything
 * other than a quiet market. A browser press is a different process and cannot
 * discard a firing by itself; what it can do is hold the board lock for the
 * whole of its run, so the firings that land inside it report
 * `another-pass-is-running` and collect nothing.
 *
 * Either way the number a reader needs is the same, which is why one constant
 * serves both and the copy is worded as time rather than as a mechanism.
 */
export const PASS_OVERRUN_MINUTES = 15;

/** Where the warning starts saying so before it has happened. */
export const PASS_APPROACHING_MINUTES = 12;

export type PassCost = {
  months: number;
  /** Departures a pass would price. A ceiling: the cadence declines more. */
  departures: number;
  minutes: number;
  approaching: boolean;
  overrun: boolean;
};

/**
 * What a pass over these months would cost.
 *
 * The booking-horizon curve is deliberately **outside** this figure. A curve
 * covers every month of a city pair in one observation — `calendar_job`
 * deduplicates watches down to the pair before collecting — so it costs the
 * same whatever is ticked, and folding it in would move the number for a reason
 * the chips did not cause.
 */
export function passCost(months: readonly string[], today: string): PassCost {
  const departures = plannedRequests(months, today);
  const minutes = (departures * REQUEST_GAP_SECONDS) / 60;
  return {
    months: months.length,
    departures,
    minutes,
    approaching: minutes >= PASS_APPROACHING_MINUTES && minutes <= PASS_OVERRUN_MINUTES,
    overrun: minutes > PASS_OVERRUN_MINUTES,
  };
}

export function describeCost(cost: PassCost): string | null {
  if (!cost.approaching && !cost.overrun) return null;
  const estimate = `About ${Math.round(cost.minutes)} min per scan.`;
  return cost.overrun
    ? `${estimate} The next scheduled scan may be skipped.`
    : `${estimate} Close to the ${PASS_OVERRUN_MINUTES} min limit.`;
}
