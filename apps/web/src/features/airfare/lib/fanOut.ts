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
 * on the reader's own 529x460 stage, a fan-out costs about 0.0995 ms of
 * `geoPath` per kilobyte of geometry — twelve countries from 20 kB to 604 kB
 * land within a factor of two of that line, because a file's size and its
 * vertex count are the same fact told twice. So a byte budget is a frame
 * budget wearing different units. The first thing tried here — a megabyte,
 * argued from the size of the JavaScript this page already downloads —
 * measured 340 ms a frame over Europe. Five frames a second is not a map being
 * dragged, it is a map being shown to you one picture at a time, and no
 * argument about download size was ever going to notice.
 *
 * **This used to bound a cost paid every frame of a drag, which is why it was
 * a quarter of what it is now.** `reprojectionCache.ts` reprojects a country's
 * `Path2D` once and reuses it — exactly, through an affine map, whenever the
 * camera's rotation has not changed since, and at most every
 * `ROTATE_REBUILD_MS` when it has — so the frame this budget has to answer to
 * is no longer *every* frame of a gesture, only the occasional one that
 * actually rebuilds. Measured cold, once, is what the budget still has to
 * bound: 512 kB (Canada alone, 496 kB of it) rebuilds in 24 to 30 ms, with a
 * tail to 57 ms; 823 kB (Canada beside the United States, past what this
 * budget allows) rebuilds in 42 to 44 ms, with a tail past 100 ms — which is
 * the line this number is chosen to stay under. Paid at most eight times a
 * second during an actual spin, and never again once the camera stops or on a
 * Mercator pan or zoom, either one is a real but occasional hitch rather than
 * the sustained quarter-of-the-frame-rate drag the old 256 kB was sized
 * against — that comparison, and the method, are in
 * `docs/airfare-map-rendering.md`.
 *
 * Spent once per country per session, not once per view: `useSubdivisions`
 * caches forever, so panning back over ground already covered costs nothing on
 * the wire. The budget still counts those countries, because a first build is
 * still a first build regardless of how a later frame reuses it — a cache
 * that made the map heavier the longer you looked at it would only have moved
 * the cost from the connection to the hand.
 */
export const VIEW_BUDGET_BYTES = 512_000;

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
  drawn: readonly string[] = [],
  budget: number = VIEW_BUDGET_BYTES,
): FanOut {
  if (!catalogue) {
    /*
     * The floor is a country, never nothing.
     *
     * It used to be the country under the middle of the frame and nothing
     * else, which is right about the intent and wrong about the one view it
     * has to hold in: a reader zooms about the point they are pointing at, so
     * the middle of the frame after a wheel gesture is wherever the geometry
     * put it, and over a coast or an ocean that is open water. Measured cold
     * in Chrome, that is exactly what happened — the first settle after the
     * zoom gate opened planned nothing at all, and the map drew no detail
     * until the index landed and a later settle re-asked. The biggest country
     * on screen is a worse guess than the middle and an incomparably better
     * one than none.
     */
    const floor = centre ?? inView[0]?.id ?? null;
    return floor ? { countries: [floor], bytes: 0, refused: [] } : NOTHING;
  }

  /*
   * A country already drawn in detail, and still in front of the reader, keeps
   * its place ahead of a country that has not been drawn yet.
   *
   * The ranking is the on-screen area of *this* view, and every settle
   * recomputes it from scratch — so a country that fitted at one zoom could be
   * outbid at the next by a neighbour that had grown, and lose the borders the
   * reader was already looking at. Nothing had changed about it except the
   * company it was keeping. That is the sharpest form of the map not behaving
   * the same for every country: the same country, detailed and then coarse
   * again, while the reader was doing nothing but getting closer to it.
   *
   * It does not raise the budget and it does not exempt anybody from it —
   * these countries are counted in bytes exactly as before, and the country
   * under the middle of the frame is still pinned in front of all of them, so
   * the one a reader has just zoomed into can never be crowded out by the ones
   * they were shown a moment ago. What changes is only the order in which the
   * same 256 kB is spent: on what is already on screen first, and on what is
   * new with what is left.
   */
  const held = new Set(drawn);
  const rest = inView.filter((each) => each.id !== centre && each.id in catalogue);
  const order = [
    ...(centre !== null && centre in catalogue ? [centre] : []),
    ...rest.filter((each) => held.has(each.id)).map((each) => each.id),
    ...rest.filter((each) => !held.has(each.id)).map((each) => each.id),
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

/**
 * Whether a plan is worth making a reader wait for.
 *
 * `RouteMap.tsx`'s settle effect holds a plan for `SETTLE_MS` before asking
 * for it, so that spinning past a dozen countries a second sends nothing —
 * see `SETTLE_MS` there. That is a wait against the *network*, and a plan
 * whose every country has already answered once this session — successfully
 * or with nothing to give, either one settles the same query forever, see
 * `useSettledSubdivisionCountries` — is not going to touch the network at
 * all. Waiting on it anyway is waiting on nothing.
 */
export function needsSettleWait(
  countries: readonly string[],
  resolvedEver: ReadonlySet<string>,
): boolean {
  return !countries.every((country) => resolvedEver.has(country));
}
