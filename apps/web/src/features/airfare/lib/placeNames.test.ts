import { geoMercator, geoOrthographic, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import { describe, expect, it } from 'vitest';
import worldAtlas from 'world-atlas/countries-110m.json';

import { COUNTRIES } from '@/features/airfare/lib/countries';
import { facesViewer, type LngLat } from '@/features/airfare/lib/geo';
import {
  CONTINENTS,
  LABEL_ROOM,
  type View,
  continentFade,
  limbFade,
  roomFade,
  screenArea,
  withoutOverlaps,
} from '@/features/airfare/lib/globe';

const LOOKING_AT_LIMA: [number, number, number] = [77, 12, 0];
const LIMA: LngLat = [-77.114444, -12.021944];

function globeAt(scale: number): View {
  return { globe: true, scale, rotation: LOOKING_AT_LIMA };
}

function country(name: string) {
  const found = COUNTRIES.find((each) => each.name === name);
  if (!found) throw new Error(`${name} is not in the bundled outlines`);
  return found;
}

/* --------------------------------------------------------------- the fades -- */

describe('limbFade', () => {
  it('is full strength on the point the globe is turned towards', () => {
    expect(limbFade(LIMA, LOOKING_AT_LIMA)).toBe(1);
  });

  it('is nothing at all on the far side', () => {
    expect(limbFade([102, 12], LOOKING_AT_LIMA)).toBe(0);
  });

  it('goes out gradually rather than blinking at the horizon', () => {
    /*
     * The whole point of it. `facesViewer` answers yes right up to 90° and no
     * immediately after, which is correct for an arc and wrong for a name: the
     * label vanishes mid-rotation. So there has to be a band that still faces
     * the viewer and is already partly faded.
     */
    const nearLimb: LngLat = [-77 + 82, -12];
    expect(facesViewer(nearLimb, LOOKING_AT_LIMA)).toBe(true);
    const fade = limbFade(nearLimb, LOOKING_AT_LIMA);
    expect(fade).toBeGreaterThan(0);
    expect(fade).toBeLessThan(1);
  });

  it('never brightens as a point turns away', () => {
    // Past 90° of longitude, not 90: away from the equator a quarter turn in
    // longitude is less than a quarter turn of great-circle distance, so at
    // latitude -12 the limb is still 2.5° further round than that.
    let previous = Infinity;
    for (let step = 0; step <= 110; step += 5) {
      const fade = limbFade([-77 + step, -12], LOOKING_AT_LIMA);
      expect(fade).toBeLessThanOrEqual(previous + 1e-9);
      previous = fade;
    }
    expect(previous).toBe(0);
  });
});

describe('continentFade', () => {
  it('has the continents named while you are looking at the whole world', () => {
    expect(continentFade(1)).toBe(1);
  });

  it('hands over to the countries once the view has closed in', () => {
    expect(continentFade(3)).toBe(0);
    expect(continentFade(8)).toBe(0);
  });

  it('crosses over rather than switching', () => {
    const middle = continentFade(2.4);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(1);
  });
});

describe('roomFade', () => {
  it('says no to a country with less room than its name needs', () => {
    expect(roomFade(LABEL_ROOM * 0.9)).toBe(0);
  });

  it('says yes once there is comfortably room', () => {
    expect(roomFade(LABEL_ROOM * 2)).toBe(1);
  });

  it('fades in over less than a single press of the zoom button', () => {
    // A step is 1.5× linear and so 2.25× in area, which is wider than the
    // band — that is what keeps a name from appearing all at once.
    expect(roomFade(LABEL_ROOM * 1.4)).toBeGreaterThan(0);
    expect(roomFade(LABEL_ROOM * 1.4)).toBeLessThan(1);
  });
});

/* ------------------------------------------------------------ the estimate -- */

const WORLD = feature(
  worldAtlas as never,
  (worldAtlas as never as { objects: { countries: never } }).objects.countries,
) as unknown as { features: { properties: { name: string } }[] };

function outline(name: string) {
  const found = WORLD.features.find((each) => each.properties.name === name);
  if (!found) throw new Error(`${name} is not in the bundled outlines`);
  return found as never;
}

describe('screenArea', () => {
  /*
   * The estimate is the projection's local area scale factor — `r²·cos θ` on
   * an orthographic, `s²·sec²φ` on a Mercator — rather than a streamed
   * polygon, because it runs per name per frame. These check it against what
   * d3 actually measures. If it drifts, names start turning up over places too
   * small to hold them.
   */

  it.each(['Peru', 'Brazil', 'Kenya'])('matches what d3 measures on the globe: %s', (name) => {
    const { at, area } = country(name);
    for (const turn of [0, 45, 70]) {
      const rotation: [number, number, number] = [-at[0] + turn, -at[1], 0];
      const projection = geoOrthographic()
        .scale(300)
        .translate([0, 0])
        .rotate([rotation[0], rotation[1]]);
      const measured = Math.abs(geoPath(projection).area(outline(name)));
      const estimated = screenArea(area, at, { globe: true, scale: 300, rotation });
      expect(Math.abs(estimated - measured) / measured).toBeLessThan(0.08);
    }
  });

  it.each(['Peru', 'France', 'Sweden'])('matches what d3 measures flat: %s', (name) => {
    const { at, area } = country(name);
    const projection = geoMercator().scale(200).translate([0, 0]).rotate([0, 0]);
    const measured = Math.abs(geoPath(projection).area(outline(name)));
    const estimated = screenArea(area, at, { globe: false, scale: 200, rotation: [0, 0, 0] });
    expect(Math.abs(estimated - measured) / measured).toBeLessThan(0.08);
  });

  it('shrinks a country as it turns towards the limb', () => {
    const peru = country('Peru');
    const facing = screenArea(peru.area, peru.at, {
      globe: true,
      scale: 300,
      rotation: [-peru.at[0], -peru.at[1], 0],
    });
    const oblique = screenArea(peru.area, peru.at, {
      globe: true,
      scale: 300,
      rotation: [-peru.at[0] + 60, -peru.at[1], 0],
    });
    expect(oblique).toBeLessThan(facing);
    expect(oblique).toBeGreaterThan(0);
  });

  it('never goes negative on the hemisphere that is facing away', () => {
    // `cos θ` turns negative past the limb, and a negative area would read as
    // "no room here" by accident rather than on purpose.
    const peru = country('Peru');
    expect(screenArea(peru.area, peru.at, globeAt(300))).toBeGreaterThan(0);
    const antipode: [number, number, number] = [-peru.at[0] + 180, peru.at[1], 0];
    expect(screenArea(peru.area, peru.at, { globe: true, scale: 300, rotation: antipode })).toBe(0);
  });

  it('grows with the zoom, which is what makes names arrive', () => {
    const peru = country('Peru');
    expect(screenArea(peru.area, peru.at, globeAt(600))).toBeCloseTo(
      screenArea(peru.area, peru.at, globeAt(300)) * 4,
      5,
    );
  });
});

/* ------------------------------------------------------------- the piling -- */

describe('withoutOverlaps', () => {
  const box = (key: string, x: number, y: number) => ({ key, x, y, width: 60, height: 16 });

  it('keeps names that are nowhere near each other', () => {
    expect(withoutOverlaps([box('a', 0, 0), box('b', 200, 0), box('c', 0, 90)])).toHaveLength(3);
  });

  it('gives the ground to whichever was offered first', () => {
    // Offered biggest first, so the bigger country keeps the spot it wanted
    // and the smaller one is the one that has to move.
    const [big, small] = withoutOverlaps([box('big', 100, 100), box('small', 110, 104)]);
    expect(big.y).toBe(100);
    expect(Math.abs(small.y - 104)).toBeGreaterThanOrEqual(17);
  });

  it('moves the loser rather than silently losing it', () => {
    const kept = withoutOverlaps([box('a', 100, 100), box('b', 110, 100), box('c', 400, 100)]);
    expect(kept.map((name) => name.key)).toEqual(['a', 'b', 'c']);
    expect(kept[0].y).toBe(100);
    expect(kept[1].y).not.toBe(100);
  });

  it('counts touching edges as clear, not as a collision', () => {
    expect(withoutOverlaps([box('a', 0, 0), box('b', 60, 0)])).toHaveLength(2);
  });

  it('has nothing to sort out when nothing was offered', () => {
    expect(withoutOverlaps([])).toEqual([]);
  });

  it('will not print a place name across an airport code', () => {
    // The codes are the data the map exists for. A continent name landing on
    // LIM — which it does, since every route on this page starts there — is
    // decoration covering the thing being decorated.
    const lima = { x: 100, y: 100, width: 32, height: 17 };
    const [moved] = withoutOverlaps([box('South America', 104, 102)], [lima]);
    expect(Math.abs(moved.y - 102)).toBeGreaterThanOrEqual(17);
  });

  it('steps a blocked name aside rather than dropping it', () => {
    /*
     * LIM sits almost exactly on the middle of South America, so a rule that
     * simply culled the loser would leave the one continent this reader is
     * looking at as the one continent with no name on it.
     */
    const lima = { x: 100, y: 100, width: 32, height: 17 };
    expect(withoutOverlaps([box('South America', 104, 102)], [lima])).toHaveLength(1);
  });

  it('gives up when every offset it is allowed is taken too', () => {
    const wall = [-34, -17, 0, 17, 34].map((step) => ({
      x: 100,
      y: 100 + step,
      width: 200,
      height: 17,
    }));
    expect(withoutOverlaps([box('blocked', 100, 100)], wall)).toEqual([]);
  });
});

/* ----------------------------------------------------------- the countries -- */

describe('COUNTRIES', () => {
  it('names the countries the bundled outlines already draw', () => {
    // 177 shapes, less Antarctica, which is a band along the bottom of every
    // projection rather than a shape with a middle. The continent layer names
    // that one instead.
    expect(COUNTRIES).toHaveLength(176);
    expect(COUNTRIES.map((each) => each.name)).not.toContain('Antarctica');
  });

  it('is biggest first, which is the order they claim space in', () => {
    expect(COUNTRIES[0].name).toBe('Russia');
    for (const [index, each] of COUNTRIES.entries()) {
      if (index === 0) continue;
      expect(each.area).toBeLessThanOrEqual(COUNTRIES[index - 1].area);
    }
  });

  it('puts a name on the mainland rather than out at sea', () => {
    /*
     * A whole-shape centroid averages the outlying territories in: France's
     * lands in the Atlantic, four degrees west of Brittany, because French
     * Guiana and Réunion pull on it. The largest polygon puts it back.
     */
    const france = country('France');
    expect(france.at[0]).toBeGreaterThan(0);
    expect(france.at[1]).toBeGreaterThan(44);
    expect(france.at[1]).toBeLessThan(50);
  });

  it('places every name somewhere on the planet', () => {
    for (const { name, at } of COUNTRIES) {
      expect(Number.isFinite(at[0]), `${name} longitude`).toBe(true);
      expect(at[0], `${name} longitude`).toBeGreaterThanOrEqual(-180);
      expect(at[0], `${name} longitude`).toBeLessThanOrEqual(180);
      expect(at[1], `${name} latitude`).toBeGreaterThanOrEqual(-90);
      expect(at[1], `${name} latitude`).toBeLessThanOrEqual(90);
    }
  });

  it('has the countries this reader flies to', () => {
    const names = COUNTRIES.map((each) => each.name);
    for (const name of ['Peru', 'Chile', 'Spain', 'United States of America']) {
      expect(names).toContain(name);
    }
  });

  it('measures a country by the whole of it, islands included', () => {
    // Ranked on the whole archipelago rather than on the one island its name
    // sits over, or Indonesia loses its label to countries a third its size.
    expect(country('Indonesia').area).toBeGreaterThan(country('Peru').area);
  });
});

describe('the two layers together', () => {
  it('never has both at full strength', () => {
    // Continents orient you on a whole globe; country names only mean
    // something once you can see a border. Both at once is clutter.
    const peru = country('Peru');
    for (const zoom of [1, 2, 3, 5, 8]) {
      const countries = roomFade(screenArea(peru.area, peru.at, globeAt(193 * zoom)));
      expect(Math.min(continentFade(zoom), countries)).toBeLessThan(1);
    }
    expect(CONTINENTS).toHaveLength(7);
  });
});
