/**
 * A colour per watched route, so an arc can be told from the arc beside it.
 *
 * Seven arcs all in the accent are seven arcs nobody can tell apart, and this
 * page draws them all from the same origin — they leave Lima as a fan of
 * identical lines. The colour is identity, not judgement: it says *which*
 * route, and nothing at all about the price.
 *
 * Built rather than picked. Seven hues evenly around the wheel from the app's
 * own accent, every one of them fitted to the same **perceived** luminance as
 * that accent (0.424, matched to within 0.002) at a single moderate
 * saturation. That is what makes them read as one family on a warm dark
 * ground: none is brighter than the others, so none takes over the map, and
 * the only thing separating them is temperature. An earlier hand-picked set
 * failed exactly here — amber and copper sat 22 apart in RGB, which is not a
 * difference anyone can use.
 */
export const ROUTE_COLOURS = [
  '#d6a65d', // amber — the app's accent, unchanged
  '#70b9c9', // sky
  '#da9eae', // rose
  '#5dc27d', // green
  '#d29cd9', // orchid
  '#8bbd50', // lime
  '#aba9de', // lavender
] as const;

/*
 * The order is a stride across the wheel rather than around it. Going round in
 * order puts the two closest colours next to each other, and *next to each
 * other* is where it matters — those are the routes read as a pair. Striding
 * by three lifts the smallest gap between neighbours from 41 to 113 in RGB
 * while the family as a whole is unchanged.
 */

/**
 * The colour for a route at this position in the watchlist.
 *
 * By position rather than hashed from the route: a hash survives reordering,
 * but two routes can land on the same slot and there is no repair for that.
 * By position the first seven are always distinct, and the list carries the
 * same colour beside each row, so the mapping is visible rather than something
 * to work out.
 *
 * Past seven the ramp repeats. That is more arcs than a globe reads well
 * anyway, and an eighth colour would only be an eighth near-duplicate.
 */
export function routeColour(index: number): string {
  const count = ROUTE_COLOURS.length;
  return ROUTE_COLOURS[((index % count) + count) % count];
}
