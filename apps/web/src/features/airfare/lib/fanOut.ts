import type { CountryInView } from '@/features/airfare/lib/countries';

/**
 * Which of the countries in front of the reader the map will draw in detail.
 *
 * The map used to detail one country: the one under the middle of the frame.
 * That left the reader looking at eleven named Peruvian departments with
 * Bolivia beside them as a flat shape and Chile below with no internal lines
 * at all — one detailed country sitting among blank neighbours, which reads as
 * a map that is broken rather than a map that is deliberate. So the client now
 * asks for the set the camera intersects, and the moment it does, there has to
 * be an answer to how much that is allowed to cost.
 *
 * **The unit is bytes, not countries.** The files run from 4 kB to Russia's
 * 618 kB and the United States alone is eight Bolivias, so a cap on how many
 * countries would be a cap on nothing: two countries can outweigh thirty. The
 * catalogue is fetched once so the cost of each is known before any of it is
 * spent — see `routers/geography.get_subdivision_catalogue`.
 *
 * **The order is on-screen area, with the middle of the frame pinned first.**
 * Area because the budget should buy the countries the reader is actually
 * looking at, and the middle pinned in front of it because that is the country
 * they zoomed into — it was the whole rule before this change and it must not
 * become a country that loses a tie. Near a frontier the neighbour can hold
 * more of the frame than the country you are standing in, and the country you
 * are standing in is still the one you asked for.
 *
 * **A country too big for what is left is passed over, not stopped at.** The
 * first rule written here stopped at the first country that would not fit, so
 * that what was drawn was always a prefix of "biggest on screen first" — a
 * rule a reader could watch holding. Measured over Europe it was the wrong
 * rule by a long way: Russia is the biggest thing on that screen and 604 kB of
 * the budget, and stopping behind it left Germany, Italy, Poland and the
 * Netherlands coarse for want of the 20 to 50 kB each that was still there.
 * Passing it over fills the same view with eight countries instead of one.
 * What a reader can see is the same either way, and it is the thing that
 * matters: which countries have borders inside them.
 *
 * **At the limit the map does not pretend.** What the budget will not stretch
 * to is drawn exactly as a country nobody has zoomed into: its coarse outline,
 * and its own name at full strength. That is what keeps the map honest without
 * a banner — every country on screen is either showing its subdivisions and
 * has given up its name to them, or is showing its name. There is no third
 * state, so a reader can always see which countries were drawn in detail by
 * looking at which ones stopped being a name, and the count they read off the
 * map is the true one.
 *
 * **The first country is never refused**, whatever it weighs — the one under
 * the middle of the frame, or the biggest on screen when the middle is open
 * water. The map detailed exactly one country before this change and never
 * asked what that country cost; a budget that could take that away would be a
 * step backwards dressed as a policy. So the budget governs the neighbours the
 * fan-out adds, and the floor underneath it is what the map already did.
 */

/**
 * What one view may spend on geometry, in bytes.
 *
 * **The wire is not what makes this number, the frame is.** Measured in Chrome
 * on the reader's own 529x460 stage, a fan-out costs 0.0995 ms of `geoPath`
 * per kilobyte of geometry per frame — twelve countries from 20 kB to 604 kB
 * land within a factor of two of that line, because a file's size and its
 * vertex count are the same fact told twice. So a byte budget is a frame
 * budget wearing different units, and the units the reader actually feels are
 * the frame's: the whole map draws in 26.3 ms today with a pointer down, and
 * the first thing tried here — a megabyte, argued from the size of the
 * JavaScript this page already downloads — measured 340 ms a frame over
 * Europe. Five frames a second is not a map being dragged, it is a map being
 * shown to you one picture at a time, and no argument about download size was
 * ever going to notice.
 *
 * 256 kB is 25 ms, so the fine layer at its very limit costs about what the
 * whole map already costs and a drag at its worst is half the frame rate it
 * was. It is also, and not by coincidence, what the view this change exists
 * for weighs: Peru, Bolivia, Chile and Argentina across their shared corner
 * are 248 kB together.
 *
 * Spent once per country per session, not once per view: `useSubdivisions`
 * caches forever, so panning back over ground already covered costs nothing on
 * the wire. The budget still counts those countries, because it is the frame
 * it is protecting and a cached country is drawn exactly as often as a fetched
 * one — a cache that made the map heavier the longer you looked at it would
 * only have moved the cost from the connection to the hand.
 */
export const VIEW_BUDGET_BYTES = 256_000;

export type FanOut = {
  /** The countries to fetch and draw, in the order they earned their place. */
  countries: string[];
  /** What those countries weigh together. */
  bytes: number;
  /**
   * Countries in view that the budget would not stretch to.
   *
   * Not an error and not shown as one — they keep their coarse outline and
   * their own name. It is here because a policy that cannot say what it
   * refused cannot be tested, and a silent cap is the one thing this must not
   * be.
   */
  refused: string[];
};

const NOTHING: FanOut = { countries: [], bytes: 0, refused: [] };

/**
 * The plan for one view.
 *
 * `catalogue` is `undefined` until the index has landed, and until then the
 * plan is the country under the middle of the frame and nothing else — which
 * is exactly how the map behaved before there was an index, so the first
 * settle after a cold start draws the country the reader zoomed into rather
 * than waiting on a second request to find out what it may draw.
 *
 * A country with no entry in the catalogue is not refused and is not requested
 * either: Natural Earth does not divide it, there is nothing to fetch, and the
 * 404 that used to establish that is a round trip a fan-out cannot afford to
 * make thirty times.
 */
export function planFanOut(
  inView: readonly CountryInView[],
  centre: string | null,
  catalogue: Record<string, number> | undefined,
  budget: number = VIEW_BUDGET_BYTES,
): FanOut {
  if (!catalogue) {
    return centre ? { countries: [centre], bytes: 0, refused: [] } : NOTHING;
  }

  const order = [
    ...(centre !== null && centre in catalogue ? [centre] : []),
    ...inView.map((each) => each.id).filter((id) => id !== centre && id in catalogue),
  ];

  const countries: string[] = [];
  const refused: string[] = [];
  let bytes = 0;
  for (const id of order) {
    const cost = catalogue[id];
    // The first is the country under the middle of the frame when there is
    // one, and it goes in whatever it weighs — see above. After that, a
    // country that will not fit is passed over and the next one is tried,
    // because the budget's job is to bound the frame and not to draw a line
    // across a ranking.
    if (countries.length > 0 && bytes + cost > budget) {
      refused.push(id);
      continue;
    }
    countries.push(id);
    bytes += cost;
  }
  return { countries, bytes, refused };
}
