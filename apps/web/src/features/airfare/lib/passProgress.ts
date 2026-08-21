import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { isOurPass } from '@/features/airfare/lib/rowReport';
import type { CollectResponse } from '@/shared/api/fares';

/**
 * How far this row's pass has got, as a bar can draw it.
 *
 * Its own module rather than a field on `RowReport`, and for that module's own
 * reason: `rowReport` turns a pass into a *sentence*, and a fraction is not one.
 * The two are read together on the same row and are deliberately not the same
 * function — the words say what happened and survive the pass, the fraction
 * says how much is left and exists only while it runs.
 *
 * Pure, so what a bar does at each of the awkward moments — a plan that has not
 * settled, a pass with nothing to do, somebody else's pass — is pinned in a test
 * rather than inferred from a stylesheet.
 */

export type PassProgress = {
  /** Departures that have come back. */
  completed: number;
  /** How many the pass means to poll, or null while the plan is unsettled. */
  polling: number | null;
  /**
   * 0 to 1, or null where there is no denominator to divide by.
   *
   * Null is the whole reason this is not just `completed / polling`: for the
   * first moments of a pass the server has not settled which departures it
   * means to poll, and a bar drawn at zero would be claiming a denominator it
   * does not have. A bar that says "moving, length unknown" is the honest mark
   * for that, and it needs to be able to tell the two apart.
   */
  fraction: number | null;
};

/**
 * The pass in hand, or null where a row has no bar to draw.
 *
 * Null in three different situations that all come to the same thing on screen:
 *
 * - the pass is not running, so there is nothing in flight — a finished pass is
 *   reported in words and a bar left at full would go on claiming work;
 * - the pass is somebody else's, answered to this row because the server keeps
 *   one slot (12.210). The row says so in a sentence; a bar would be that
 *   sentence contradicted by a picture, which is the quieter of the two;
 * - the plan settled at nothing to poll, which happens on every press against a
 *   month already collected inside its cadence. There is no bar that can fill
 *   from zero to zero, and the words — "Not collected: 31 not-due" — are the
 *   whole of what happened.
 */
export function passProgress(route: FareRoute, response: CollectResponse): PassProgress | null {
  if (response.state !== 'running') return null;
  if (!isOurPass(route, response)) return null;

  const polling = response.polling;
  if (polling === null) return { completed: response.completed, polling: null, fraction: null };
  if (polling <= 0) return null;

  return {
    completed: response.completed,
    polling,
    fraction: response.completed / polling,
  };
}
