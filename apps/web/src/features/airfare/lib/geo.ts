import { geoDistance, geoInterpolate } from 'd3-geo';

import type { Airport } from '@/shared/api/fares';

/**
 * The geometry a route map needs, kept away from the drawing.
 *
 * Everything here is pure and coordinate-only: no canvas, no projection state,
 * no React. That is what lets the interesting parts — is this arc a great
 * circle, is this endpoint on the far side of the globe — be tested without a
 * WebGL context or a jsdom canvas, which is the same reason the price chart is
 * SVG rather than canvas (decision 12.12).
 */

export type LngLat = [number, number];

/** One watched route drawn by an arc, as the map needs to know it. */
export type ArcWatch = {
  /** The watchlist's own id — `LIM|SCL|2027-03`, from `routeId`. */
  id: string;
  origin: string;
  destination: string;
};

/**
 * Where an arc's two ends are, and which watches it stands for.
 *
 * **One of these is one arc, and an arc is a city pair** — decision
 * `a-pair-draws-one-arc`. It used to be one per watched route, which put two
 * dotted lines on the same great circle the moment a return leg was watched:
 * the same two airports, the same curve, one drawn on top of the other, and
 * the only way to see there were two was that the upper one hid the lower
 * one's colour. Nothing about a second watch is visible in a line's *shape*,
 * so nothing about it should be drawn as a second line.
 *
 * That rule is stated over the **unordered** pair and takes no notice of
 * direction or of month, so `LIM→SCL` and `SCL→LIM` collapse and so do
 * `LIM→SCL` in March and `LIM→SCL` in June. Two watches in the same direction
 * are the same curve down to the sample, which is the case where the overdraw
 * is most complete and least visible.
 *
 * What is lost is drawn elsewhere rather than dropped: the watchlist beside
 * the map has a row per watch with its own colour, its own month and its own
 * collection report, and that list is where a watch is a thing you can count.
 */
export type RouteGeometry = {
  /** The city pair, both codes sorted — `LIM~SCL`. One arc, one id. */
  id: string;
  /** Every watch this arc stands for, in watchlist order. Never empty. */
  watches: ArcWatch[];
  /**
   * The watch the arc is **pointed at**, by id — its direction and its name.
   *
   * Not its colour. An arc used to express one watch in everything it showed —
   * `arc-wears-its-leading-watch` — and that is over: the owner asked for the
   * dashes to run the way of the route they have selected and for the line's
   * colour not to move when they select it, so the two halves are now decided
   * separately and can name different watches. `wearing` is the other half.
   *
   * **The open watch leads its own arc** — `the-open-watch-leads-its-arc`. On
   * the arc the reader has open the answer is the watch they opened, whatever
   * has collected since; every other arc is still pointed by
   * `flow-follows-the-last-collected` and then by watchlist order.
   */
  leading: string;
  /**
   * The watch whose colour the arc is drawn in, by id.
   *
   * The **first** of its watches in watchlist order, and nothing moves it —
   * `colour-holds-the-first-watch`. Not the open one, because the owner was
   * explicit that clicking between the two legs of a pair must not change the
   * line's colour; not the last-collected one, because that moves on its own
   * while the reader is looking elsewhere. Watchlist order is the one anchor
   * the reader owns outright: it changes when they drag a row and at no other
   * time.
   *
   * What it costs is that the swatch beside the watchlist is no longer a
   * complete index into the map. On a pair watched both ways, one of the two
   * rows' colours is drawn and the other's is not — the arc is one line and
   * cannot carry two.
   */
  wearing: string;
  /** The leading watch's origin — the end the arc runs *from*. */
  origin: string;
  destination: string;
  from: LngLat;
  to: LngLat;
  fromCity: string | null;
  toCity: string | null;
  /**
   * Whether some watch on this arc flies the other way.
   *
   * The endpoint markers read it: this map draws a departure as a neutral dot
   * and an arrival as a coloured one, and on a pair watched both ways both
   * ends are departures — `a-both-ways-pair-has-two-homes`.
   */
  bothWays: boolean;
};

export function airportPoint(airport: Airport): LngLat {
  // GeoJSON order, which is longitude first — the opposite of how every
  // airport database and every human writes it. Getting this backwards puts
  // Lima in the Indian Ocean, so it is converted in exactly one place.
  return [airport.longitude, airport.latitude];
}

/**
 * What makes two watches the same arc: the two codes, in no order.
 *
 * Sorted rather than hashed, so the key a caller builds from `SCL` and `LIM`
 * is the same string the caller who has them the other way round builds. The
 * separator is a character IATA has none of, so `LIM~SCL` can be split back
 * apart if anything ever needs to and can never be produced by two other
 * codes.
 */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}~${b}` : `${b}~${a}`;
}

/**
 * One direction along a pair — `SCL>LIM`. The thing an arc's flow expresses.
 *
 * Deliberately *not* a route id: a heading is a fact about a leg, and the two
 * watches on `LIM→SCL` for March and for June share one. A heading recorded
 * against a route id would leave June's arc pointing the wrong way for want of
 * a collection it had no reason to run.
 */
export function legKey(origin: string, destination: string): string {
  return `${origin}>${destination}`;
}

/**
 * One arc per watched city pair, in watchlist order.
 *
 * A route whose airports are not known yet is dropped rather than guessed at:
 * coordinates arrive with the first collection, so an uncollected route simply
 * has no arc until it has been looked at once. A **return** leg on a pair
 * already watched is the case where that costs nothing — both its airports
 * were resolved by the outbound leg's first collection, so its arc is drawable
 * the instant the watch is added, before anything has been fetched for it.
 *
 * Which watch an arc is **pointed at** is decided in three steps, and the first
 * one that answers wins. Which watch it is **coloured for** is not decided here
 * at all in the sense of being chosen: it is `watches[0]`, the first in
 * watchlist order, whatever the other three steps say —
 * `colour-holds-the-first-watch`.
 *
 * 1. **`open`, if it is one of this arc's watches** —
 *    `the-open-watch-leads-its-arc`. The owner asked for the animation to run
 *    the way of the route they have selected, and direction is a property of
 *    the geometry here, so the selection has to reach this function or it
 *    cannot reach the dashes. It is matched by watch id rather than by leg, so
 *    the arc expresses the watch the reader opened and not merely a watch that
 *    happens to fly the same way — which is what keeps the colour and the name
 *    on the row they clicked when a pair is watched twice in one direction.
 * 2. **`flowing`** — which way each pair's arc runs by what collected last: a
 *    pair key from `pairKey` against a leg key from `legKey`. The leading watch
 *    is the first one in watchlist order that flies that way. A leg key rather
 *    than a route id on purpose: a heading is a fact about a leg, shared by
 *    every month watched along it.
 * 3. **Watchlist order** — where the pair is in neither, or is pointed down a
 *    leg nothing watches any more (the case where the reader has just removed
 *    one of two watches), the first watch in watchlist order leads. That
 *    default is deterministic across reloads and is an order the reader owns,
 *    because dragging a row changes it.
 */
export function routeGeometries(
  routes: { origin: string; destination: string; id: string }[],
  airports: Map<string, Airport>,
  flowing: ReadonlyMap<string, string> = new Map(),
  open: string | null = null,
): RouteGeometry[] {
  // Insertion order is watchlist order, and a `Map` keeps it — so a pair sits
  // where its *earliest* watch sits, and an arc does not jump down the map
  // when a second watch on it is added at the end of the list.
  const byPair = new Map<string, ArcWatch[]>();
  for (const route of routes) {
    if (!airports.has(route.origin) || !airports.has(route.destination)) continue;
    const key = pairKey(route.origin, route.destination);
    const watch: ArcWatch = {
      id: route.id,
      origin: route.origin,
      destination: route.destination,
    };
    const gathered = byPair.get(key);
    if (gathered) gathered.push(watch);
    else byPair.set(key, [watch]);
  }

  const found: RouteGeometry[] = [];
  for (const [id, watches] of byPair) {
    const heading = flowing.get(id);
    const leading =
      // The open watch first, and only on the arc it belongs to: an arc the
      // reader has not opened is left to say what it has always said.
      watches.find((watch) => watch.id === open) ??
      watches.find((watch) => legKey(watch.origin, watch.destination) === heading) ??
      watches[0];
    const from = airports.get(leading.origin);
    const to = airports.get(leading.destination);
    // Both were present when the watch was gathered; this is what says so to
    // the type checker without an assertion that could outlive the reason.
    if (!from || !to) continue;
    found.push({
      id,
      watches,
      leading: leading.id,
      // Watchlist order, and only watchlist order. Neither the selection nor a
      // finished collection reaches this line.
      wearing: watches[0].id,
      origin: leading.origin,
      destination: leading.destination,
      from: airportPoint(from),
      to: airportPoint(to),
      fromCity: from.city,
      toCity: to.city,
      bothWays: watches.some((watch) => watch.origin !== leading.origin),
    });
  }
  return found;
}

/**
 * Which watch a press on this arc should open.
 *
 * The leading one — unless it is already the open one, in which case the next
 * watch along, wrapping. Decision `arc-click-cycles-its-watches`.
 *
 * The alternative was to always answer the leading watch, and it was rejected
 * for what it does to the other one: an arc that stands for two watches would
 * be able to open only ever the same one of them, and the second would be a
 * line the reader can see, can hover, can click — and cannot reach. The
 * watchlist can still open it, but a control that draws two things and opens
 * one of them is a control that lies about what it does.
 *
 * On the ordinary arc, which stands for a single watch, this is a press that
 * selects that watch and a second press that selects it again. The cycling
 * only appears where there is something to cycle through.
 *
 * **`the-open-watch-leads-its-arc` does not disturb it**, and that is worth
 * saying because the two rules meet exactly here. On the arc that holds the
 * open watch, `leading` is now that watch — so the first branch is the one
 * that never fires and every press takes the second, which walks the list and
 * wraps. On every other arc `open` is not among its watches at all, `leading`
 * is whatever the flow and the watchlist made it, and the first branch answers
 * as before. Either way each press moves on by one and none of an arc's
 * watches becomes unreachable.
 *
 * `colour-holds-the-first-watch` does not disturb it either, and that is the
 * colder of the two checks: colour has no part in this function. What it
 * changes is what a first press on an unopened both-ways arc *means* — it
 * opens the watch the line is pointing at, which is no longer necessarily the
 * watch the line is coloured for. That is the price of the split rather than a
 * fault in the cycle: the press still lands on a watch this arc stands for,
 * and the press after it reaches the other one.
 */
export function nextWatch(arc: RouteGeometry, openId: string | null): string {
  const at = arc.watches.findIndex((watch) => watch.id === openId);
  if (at < 0) return arc.leading;
  return arc.watches[(at + 1) % arc.watches.length].id;
}

/**
 * The path an aircraft actually flies, sampled as a line string.
 *
 * A great circle, not a curve drawn in longitude and latitude. On LIM–CUZ the
 * two are indistinguishable; on LIM–MAD, crossing the Atlantic, a lng/lat
 * curve visibly misses the real track — which is the flaw the one mature
 * component in this space still ships (its great-circle fix is an unmerged
 * pull request).
 *
 * The sample count follows the distance so a short hop is not spending sixty
 * points on a straight line and a long haul is not visibly faceted.
 */
export function greatCircle(
  from: LngLat,
  to: LngLat,
): { type: 'LineString'; coordinates: LngLat[] } {
  const along = geoInterpolate(from, to);
  const steps = Math.min(96, Math.max(16, Math.round(geoDistance(from, to) * 110)));
  return {
    type: 'LineString',
    coordinates: Array.from({ length: steps + 1 }, (_, index) => along(index / steps)),
  };
}

/**
 * Whether a point faces the viewer on a globe rotated to `rotation`.
 *
 * `geoOrthographic` clips paths at the limb for us, but a label or a dot is
 * positioned rather than clipped, so without this check every airport on the
 * far side is drawn mirrored onto the near one.
 */
export function facesViewer(point: LngLat, rotation: [number, number, number]): boolean {
  return geoDistance(point, [-rotation[0], -rotation[1]]) <= Math.PI / 2;
}

/**
 * Where the sun is directly overhead, right now.
 *
 * Two standard approximations, good to about a degree — plenty for a globe a
 * few hundred pixels across, and the reason this is arithmetic rather than an
 * ephemeris. The declination follows the day of year: a cosine that peaks at
 * the solstices and crosses zero at the equinoxes, phased so day 172 (21
 * June) reads near +23.44° and day 355 (21 December) near -23.44°. The
 * longitude follows the clock: solar noon is under the sun at 0° longitude at
 * 12:00 UTC, and the sun crosses 15° of longitude an hour either side of that.
 */
export function subsolarPoint(at: Date): LngLat {
  const start = Date.UTC(at.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((at.getTime() - start) / 86_400_000);
  const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));

  const utcHours = at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;
  const longitude = wrapLongitude(-(utcHours - 12) * 15);

  return [longitude, declination];
}

/** The point with no daylight at all — the centre of the night hemisphere. */
export function antisolarPoint(at: Date): LngLat {
  const [longitude, declination] = subsolarPoint(at);
  return [wrapLongitude(longitude + 180), -declination];
}

function wrapLongitude(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}
