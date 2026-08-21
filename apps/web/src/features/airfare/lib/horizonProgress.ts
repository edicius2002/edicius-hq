import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { isOurHorizonPass } from '@/features/airfare/lib/rowReport';
import type { CalendarCollectResponse } from '@/shared/api/fares';

/**
 * How far a booking-horizon pass has got, as a bar can draw it.
 *
 * **Why this is not `passProgress`.** The two look alike from a distance — both
 * turn a running pass into a fraction — and they are about different work in
 * different units, which is the whole of the argument. A board pass settles a
 * list of up to thirty-one **departures** and polls each one once, so
 * `completed / polling` is the entire story and the two numbers cannot come
 * apart. A horizon pass polls no departures at all. It prices **windows**, and
 * since 12.245 what it spends and what it achieves are genuinely two figures: a
 * far window the provider refuses is asked for again with a nearer end, so a
 * pass measured live on 2026-08-21 sent three requests to price two windows.
 *
 * Generalising `passProgress` over both was the alternative and it was rejected
 * on what it would have had to become: a function about neither unit, taking a
 * numerator and a denominator from a caller that already knew what they meant.
 * The saving is about ten lines; the cost is that the one place where the units
 * are named stops naming them.
 *
 * There is a second reason to keep them apart, and it is the stronger one. The
 * three cases where `passProgress` returns null are a deliberate reading of what
 * a board pass's bar should do, and the owner is still weighing it. Folding this
 * into that function would mean any later change to that reading silently
 * became a change to this one, decided by nobody.
 *
 * Pure, so what a bar does at each awkward moment is pinned in a test rather
 * than inferred from a stylesheet.
 */

export type HorizonProgress = {
  /** How many date windows the pass means to price, or null while unsettled. */
  windows: number | null;
  /** Windows that have come back. */
  windowsPriced: number;
  /**
   * Upstream requests sent. Above `windowsPriced` where a far window was
   * refused and asked for again — which is the pass working, not failing.
   */
  requests: number;
  /** Departure dates priced so far. */
  dates: number;
  /**
   * 0 to 1, or null where there is no denominator to divide by.
   *
   * Null is why this is not simply `windowsPriced / windows`. For the first
   * instant of a pass the server has not settled which windows it means to
   * price, and a bar drawn at zero would be claiming a length it has not been
   * told. "Moving, length unknown" is the honest mark for that moment and needs
   * to be distinguishable from "nothing done yet out of two".
   */
  fraction: number | null;
};

/**
 * The pass in hand, or null where this row has no bar to draw.
 *
 * Null in three situations, and they are this pass's own rather than a copy of
 * the board pass's:
 *
 * - the pass is not running, so nothing is in flight — a finished horizon is
 *   reported in words, and a bar left full would go on claiming work;
 * - the pass belongs to another route, answered to this one because the server
 *   keeps a single calendar slot. The row says so in a sentence, and a bar
 *   beside that sentence would be a picture contradicting it;
 * - the plan settled at no windows at all, which is what a press against a pair
 *   already collected inside its cadence comes to. There is no bar that fills
 *   from zero to zero, and "not collected again — not-due" is the whole of what
 *   happened.
 */
export function horizonProgress(
  route: FareRoute,
  response: CalendarCollectResponse,
): HorizonProgress | null {
  if (response.state !== 'running') return null;
  if (!isOurHorizonPass(route, response)) return null;

  const { windows, windowsPriced, requests, dates } = response;
  if (windows === null) {
    return { windows: null, windowsPriced, requests, dates, fraction: null };
  }
  if (windows <= 0) return null;

  return {
    windows,
    windowsPriced,
    requests,
    dates,
    // Clamped by the caller rather than here, exactly as the board's bar does
    // it: the figure is what the server said, and a chart that quietly rounds a
    // disagreement away is a chart that cannot report one.
    fraction: windowsPriced / windows,
  };
}
