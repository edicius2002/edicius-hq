import { geoDistance } from 'd3-geo';
import { describe, expect, it } from 'vitest';

import {
  airportPoint,
  antisolarPoint,
  facesViewer,
  greatCircle,
  legKey,
  nextWatch,
  pairKey,
  routeGeometries,
  subsolarPoint,
} from '@/features/airfare/lib/geo';
import type { Airport } from '@/shared/api/fares';

const LIMA: Airport = {
  code: 'LIM',
  name: 'New Jorge Chávez International Airport',
  city: 'Lima',
  country: 'Peru',
  latitude: -12.021944,
  longitude: -77.114444,
};

const MADRID: Airport = {
  code: 'MAD',
  name: 'Adolfo Suárez Madrid–Barajas Airport',
  city: 'Madrid',
  country: 'Spain',
  latitude: 40.498333,
  longitude: -3.567222,
};

describe('airportPoint', () => {
  it('puts longitude first, which is the opposite of how a human writes it', () => {
    // Getting this backwards puts Lima in the Indian Ocean, so it is converted
    // in exactly one place and that place is tested.
    expect(airportPoint(LIMA)).toEqual([-77.114444, -12.021944]);
  });
});

describe('greatCircle', () => {
  it('starts and ends exactly where the airports are', () => {
    const line = greatCircle(airportPoint(LIMA), airportPoint(MADRID));
    expect(line.coordinates[0][0]).toBeCloseTo(-77.114444, 4);
    expect(line.coordinates.at(-1)![1]).toBeCloseTo(40.498333, 4);
  });

  it('bows away from the straight lng/lat line on a long haul', () => {
    // The flaw worth avoiding: a curve drawn in longitude and latitude misses
    // the track an aircraft actually flies. Halfway between Lima and Madrid a
    // great circle is well north of the lng/lat midpoint.
    const line = greatCircle(airportPoint(LIMA), airportPoint(MADRID));
    const middle = line.coordinates[Math.floor(line.coordinates.length / 2)];
    const naiveLatitude = (LIMA.latitude + MADRID.latitude) / 2;
    expect(middle[1]).toBeGreaterThan(naiveLatitude + 1);
  });

  it('does not spend sixty points on a short hop', () => {
    const near = greatCircle([-77.11, -12.02], [-71.94, -13.54]);
    const far = greatCircle(airportPoint(LIMA), airportPoint(MADRID));
    expect(near.coordinates.length).toBeLessThan(far.coordinates.length);
    expect(near.coordinates.length).toBeGreaterThanOrEqual(17);
  });
});

describe('pairKey', () => {
  it('is the same key whichever way round the pair is written', () => {
    // The whole of the collapsing rests on this: a return leg has to produce
    // the key its outbound leg produced, or nothing ever meets anything.
    expect(pairKey('SCL', 'LIM')).toBe(pairKey('LIM', 'SCL'));
  });

  it('does not run two different pairs together', () => {
    expect(pairKey('LIM', 'SCL')).not.toBe(pairKey('LIM', 'SCU'));
  });
});

describe('routeGeometries', () => {
  const CUSCO: Airport = {
    code: 'CUZ',
    name: 'Alejandro Velasco Astete International Airport',
    city: 'Cusco',
    country: 'Peru',
    latitude: -13.535833,
    longitude: -71.938889,
  };

  const airports = new Map([
    ['LIM', LIMA],
    ['MAD', MADRID],
    ['CUZ', CUSCO],
  ]);

  it('resolves a watched route to two points', () => {
    const [geometry] = routeGeometries(
      [{ id: 'LIM-MAD', origin: 'LIM', destination: 'MAD' }],
      airports,
    );
    expect(geometry.from).toEqual(airportPoint(LIMA));
    expect(geometry.toCity).toBe('Madrid');
    expect(geometry.leading).toBe('LIM-MAD');
    expect(geometry.bothWays).toBe(false);
  });

  it('drops a route whose airports are not known yet rather than guessing', () => {
    // Coordinates arrive with the first collection, so an uncollected route
    // simply has no arc until it has been looked at once. Inventing one would
    // draw a line to the middle of the Atlantic.
    expect(
      routeGeometries([{ id: 'LIM-XXX', origin: 'LIM', destination: 'XXX' }], airports),
    ).toEqual([]);
  });

  it('keeps the watchlist order', () => {
    const ids = routeGeometries(
      [
        { id: 'LIM-MAD', origin: 'LIM', destination: 'MAD' },
        { id: 'LIM-CUZ', origin: 'LIM', destination: 'CUZ' },
      ],
      airports,
    ).map((geometry) => geometry.id);
    expect(ids).toEqual([pairKey('LIM', 'MAD'), pairKey('LIM', 'CUZ')]);
  });

  it('draws a return leg on the arc that is already there', () => {
    /*
     * `a-pair-draws-one-arc`, and the case the owner asked for. Two watches on
     * the same two airports are two lines on one great circle — the same
     * curve, one drawn over the other, and the only visible sign that there
     * were two was the upper one hiding the lower one's colour.
     */
    const arcs = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0].watches.map((watch) => watch.id)).toEqual([
      'LIM|MAD|2027-03',
      'MAD|LIM|2027-03',
    ]);
    expect(arcs[0].bothWays).toBe(true);
  });

  it('collapses two months on the same pair as well, which is the same overdraw', () => {
    /*
     * The rule is stated over the unordered pair and takes no notice of the
     * month, deliberately. Two watches in the same direction are the same
     * curve down to the sample — the case where the overdraw is most complete
     * and least visible — and a rule that collapsed only return legs would
     * leave this one drawn twice for want of a distinction nothing on a globe
     * can show.
     */
    const arcs = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'LIM|MAD|2027-06', origin: 'LIM', destination: 'MAD' },
      ],
      airports,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0].watches).toHaveLength(2);
    // Same direction twice, so there is no other way to be pointed.
    expect(arcs[0].bothWays).toBe(false);
  });

  it('runs the arc the way the last collected leg flies', () => {
    // `flow-follows-the-last-collected`. The return leg collected, so the line
    // already on screen turns round rather than a second one appearing.
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const [arc] = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
      flowing,
    );
    expect(arc.origin).toBe('MAD');
    expect(arc.from).toEqual(airportPoint(MADRID));
    expect(arc.leading).toBe('MAD|LIM|2027-03');
    expect(arc.fromCity).toBe('Madrid');
  });

  it('falls back to watchlist order when nothing has been collected', () => {
    // Which is the answer to "both legs have data and neither is newer": the
    // reader's own ordering decides, and dragging a row changes it.
    const [arc] = routeGeometries(
      [
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
      ],
      airports,
    );
    expect(arc.leading).toBe('MAD|LIM|2027-03');
  });

  it('ignores a heading down a leg nothing watches any more', () => {
    /*
     * Removing one of two watches on a pair. The heading recorded when the
     * return leg collected still names that leg; with the watch gone there is
     * nothing left to lead, and the arc has to come back round to the watch
     * that is still there rather than keep pointing at a route the reader has
     * deleted.
     */
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const [arc] = routeGeometries(
      [{ id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' }],
      airports,
      flowing,
    );
    expect(arc.leading).toBe('LIM|MAD|2027-03');
    expect(arc.origin).toBe('LIM');
    expect(arc.bothWays).toBe(false);
  });

  it('runs the arc the way the open watch flies, over the last collection', () => {
    /*
     * `the-open-watch-leads-its-arc`, and the owner's own words: the direction
     * of the animation must follow the origin and destination of the selected
     * route. The return leg is the one that collected, so without this the arc
     * would leave Madrid while the reader had the outbound route open, its
     * chart, its month and its "Lima to Madrid" heading all on screen below.
     */
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const [arc] = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
      flowing,
      'LIM|MAD|2027-03',
    );
    expect(arc.leading).toBe('LIM|MAD|2027-03');
    expect(arc.origin).toBe('LIM');
    expect(arc.from).toEqual(airportPoint(LIMA));
    expect(arc.fromCity).toBe('Lima');
    // The other watch has not gone anywhere; it is simply not the one being
    // pointed at.
    expect(arc.bothWays).toBe(true);
  });

  it('turns the arc round without moving its colour', () => {
    /*
     * `colour-holds-the-first-watch`, in the owner's words: "no debe cambiar
     * el color". The direction follows the selection and the colour does not
     * follow it anywhere — so the same two watches, selected either way, give
     * two directions and one `wearing`.
     */
    const watches = [
      { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
      { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
    ];
    const [outbound] = routeGeometries(watches, airports, new Map(), 'LIM|MAD|2027-03');
    const [inbound] = routeGeometries(watches, airports, new Map(), 'MAD|LIM|2027-03');

    expect(outbound.origin).toBe('LIM');
    expect(inbound.origin).toBe('MAD');
    expect(outbound.wearing).toBe('LIM|MAD|2027-03');
    expect(inbound.wearing).toBe('LIM|MAD|2027-03');
  });

  it('holds the colour still when a collection lands, too', () => {
    /*
     * The other half of the rule, and the half nobody clicked for: a pass
     * finishing on the return leg turns an unopened arc round, and a colour
     * that went with it would repaint a line while the reader was reading
     * something else entirely. Watchlist order is the anchor precisely because
     * it moves only when the reader drags a row.
     */
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const [arc] = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
      flowing,
    );
    expect(arc.leading).toBe('MAD|LIM|2027-03');
    expect(arc.wearing).toBe('LIM|MAD|2027-03');
  });

  it('gives the ordinary arc the one colour it has', () => {
    // A single watch is pointed at and coloured for itself, which is nearly
    // every arc on the page: the split shows up only where a pair is watched
    // more than once.
    const [arc] = routeGeometries(
      [{ id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' }],
      airports,
      new Map(),
      'LIM|MAD|2027-03',
    );
    expect(arc.wearing).toBe(arc.leading);
  });

  it('leaves every arc the open watch is not on to the last collection', () => {
    /*
     * The selection points one line, not the map. An open route on one pair
     * saying anything at all about another pair's direction would be a rule
     * about a route reaching a line that route is not drawn on.
     */
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const [cusco, madrid] = routeGeometries(
      [
        { id: 'LIM|CUZ|2027-03', origin: 'LIM', destination: 'CUZ' },
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
      flowing,
      'LIM|CUZ|2027-03',
    );
    expect(cusco.leading).toBe('LIM|CUZ|2027-03');
    expect(madrid.leading).toBe('MAD|LIM|2027-03');
    expect(madrid.origin).toBe('MAD');
  });

  it('names the open watch itself, not merely a watch flying its way', () => {
    /*
     * Two months on one pair are one arc and one direction, so a heading could
     * not tell them apart — matching by leg would hand the arc June's colour
     * and June's name while the reader had March open. The open watch is
     * matched by id for exactly this case.
     */
    const [arc] = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'LIM|MAD|2027-06', origin: 'LIM', destination: 'MAD' },
      ],
      airports,
      new Map(),
      'LIM|MAD|2027-06',
    );
    expect(arc.leading).toBe('LIM|MAD|2027-06');
  });

  it('ignores an open watch that has no arc here at all', () => {
    // Nothing selected, or a route whose airports have not arrived: the arcs
    // fall back to what collected last, which is the state a fresh page is in.
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const routes = [
      { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
      { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
    ];
    for (const open of [null, 'LIM|XXX|2027-03']) {
      const [arc] = routeGeometries(routes, airports, flowing, open);
      expect(arc.leading).toBe('MAD|LIM|2027-03');
    }
  });
});

describe('nextWatch', () => {
  const airports = new Map([
    ['LIM', LIMA],
    ['MAD', MADRID],
  ]);

  const [both] = routeGeometries(
    [
      { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
      { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
    ],
    airports,
  );

  it('opens the leading watch when the arc is not the open one', () => {
    expect(nextWatch(both, null)).toBe('LIM|MAD|2027-03');
    expect(nextWatch(both, 'somebody-else')).toBe('LIM|MAD|2027-03');
  });

  it('offers the other watch once the leading one is open', () => {
    // Otherwise the second watch is a line the reader can see, can hover, and
    // cannot reach from the map at all.
    expect(nextWatch(both, 'LIM|MAD|2027-03')).toBe('MAD|LIM|2027-03');
  });

  it('wraps, so a shared arc is a loop rather than a dead end', () => {
    expect(nextWatch(both, 'MAD|LIM|2027-03')).toBe('LIM|MAD|2027-03');
  });

  it('still reaches every watch once the open one leads the arc', () => {
    /*
     * `arc-click-cycles-its-watches` against `the-open-watch-leads-its-arc`,
     * which is where the two rules meet: on the open arc the leading watch is
     * now the open watch, so the "open the leading one" branch is the one that
     * never fires and every press walks the list. Built through
     * `routeGeometries` with the selection handed in rather than by hand,
     * because the pairing of `leading` and `openId` is the thing being checked
     * and a fixture could assert any pairing it liked.
     */
    const watches = [
      { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
      { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
    ];
    const [outbound] = routeGeometries(watches, airports, new Map(), 'LIM|MAD|2027-03');
    expect(outbound.leading).toBe('LIM|MAD|2027-03');
    expect(nextWatch(outbound, 'LIM|MAD|2027-03')).toBe('MAD|LIM|2027-03');

    // And the press after that, on the arc as it is then drawn: back round.
    const [inbound] = routeGeometries(watches, airports, new Map(), 'MAD|LIM|2027-03');
    expect(inbound.leading).toBe('MAD|LIM|2027-03');
    expect(nextWatch(inbound, 'MAD|LIM|2027-03')).toBe('LIM|MAD|2027-03');
  });

  it('opens the watch the line points at, which need not be the one it wears', () => {
    /*
     * `arc-click-cycles-its-watches` re-checked under
     * `colour-holds-the-first-watch`, because the split gives an unopened arc
     * two watches to be about: the return leg collected, so the line runs
     * Madrid to Lima while carrying the outbound leg's colour. A press opens
     * what the line is pointing at, and the press after it reaches the other —
     * so both are still reachable, which is all this rule ever promised.
     */
    const flowing = new Map([[pairKey('LIM', 'MAD'), legKey('MAD', 'LIM')]]);
    const [arc] = routeGeometries(
      [
        { id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' },
        { id: 'MAD|LIM|2027-03', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
      flowing,
    );
    expect(arc.wearing).toBe('LIM|MAD|2027-03');
    expect(nextWatch(arc, null)).toBe('MAD|LIM|2027-03');
    expect(nextWatch(arc, 'MAD|LIM|2027-03')).toBe('LIM|MAD|2027-03');
  });

  it('is a plain selection on the ordinary arc, which has one watch', () => {
    const [alone] = routeGeometries(
      [{ id: 'LIM|MAD|2027-03', origin: 'LIM', destination: 'MAD' }],
      airports,
    );
    expect(nextWatch(alone, null)).toBe('LIM|MAD|2027-03');
    expect(nextWatch(alone, 'LIM|MAD|2027-03')).toBe('LIM|MAD|2027-03');
  });
});

describe('facesViewer', () => {
  it('hides a point on the far side of the globe', () => {
    // `geoOrthographic` clips paths at the limb, but a label is positioned
    // rather than clipped — without this every far-side airport is drawn
    // mirrored onto the near one.
    const lookingAtLima: [number, number, number] = [77, 12, 0];
    expect(facesViewer(airportPoint(LIMA), lookingAtLima)).toBe(true);
    expect(facesViewer([139.78, 35.55], lookingAtLima)).toBe(false); // Tokyo
  });

  it('still shows Madrid from Lima, which is nearer the limb than it looks', () => {
    // Measured rather than assumed: the two are 85.7 degrees apart, so Madrid
    // is inside the visible hemisphere. Guessing "transatlantic means hidden"
    // would have hidden an arc endpoint that belongs on screen.
    expect(facesViewer(airportPoint(MADRID), [77, 12, 0])).toBe(true);
  });

  it('shows Madrid once the globe has been turned to it', () => {
    const lookingAtMadrid: [number, number, number] = [3.57, -40.5, 0];
    expect(facesViewer(airportPoint(MADRID), lookingAtMadrid)).toBe(true);
  });
});

describe('subsolarPoint', () => {
  it('puts the sun over the northern tropic at the June solstice', () => {
    const [, declination] = subsolarPoint(new Date(Date.UTC(2026, 5, 21, 12)));
    expect(declination).toBeGreaterThan(23);
  });

  it('puts the sun over the southern tropic at the December solstice', () => {
    const [, declination] = subsolarPoint(new Date(Date.UTC(2026, 11, 21, 12)));
    expect(declination).toBeLessThan(-23);
  });

  it('puts the sun near the equator at an equinox', () => {
    const [, declination] = subsolarPoint(new Date(Date.UTC(2026, 2, 20, 12)));
    expect(Math.abs(declination)).toBeLessThan(2);
  });

  it('puts the sun under whichever meridian has solar noon', () => {
    const [noon] = subsolarPoint(new Date(Date.UTC(2026, 5, 21, 12)));
    expect(noon).toBeCloseTo(0, 0);

    const [sixAM] = subsolarPoint(new Date(Date.UTC(2026, 5, 21, 6)));
    expect(sixAM).toBeCloseTo(90, 0);

    const [sixPM] = subsolarPoint(new Date(Date.UTC(2026, 5, 21, 18)));
    expect(sixPM).toBeCloseTo(-90, 0);
  });
});

describe('antisolarPoint', () => {
  it('is the point with no daylight at all: the far side and the opposite latitude', () => {
    const at = new Date(Date.UTC(2026, 5, 21, 12));
    const [sunLng, sunLat] = subsolarPoint(at);
    const [nightLng, nightLat] = antisolarPoint(at);

    expect(geoDistance([sunLng, sunLat], [nightLng, nightLat])).toBeCloseTo(Math.PI, 5);
    expect(nightLat).toBeCloseTo(-sunLat, 6);
  });
});
