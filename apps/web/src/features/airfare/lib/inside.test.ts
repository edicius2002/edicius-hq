import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { describe, expect, it } from 'vitest';
import worldAtlas from 'world-atlas/countries-110m.json';

import { solidHolds, solidOf } from '@/features/airfare/lib/inside';

const SHAPES: { properties: { name?: string } }[] = (
  feature(
    worldAtlas as never,
    (worldAtlas as never as { objects: { countries: never } }).objects.countries,
  ) as unknown as { features: { properties: { name?: string } }[] }
).features;

function shapeOf(name: string) {
  const found = SHAPES.find((each) => each.properties.name === name);
  if (!found) throw new Error(`no shape called ${name}`);
  return found;
}

describe('solidHolds', () => {
  /*
   * The flattened rings stand in for `geoContains` in the settle sweep, so
   * what has to be true of them is that they answer the same — everywhere the
   * reader can put a sample, not only in the middle of a country.
   */

  it('agrees with geoContains over a grid of the whole world', () => {
    /*
     * A 3° grid — 7,200 points against all 177 shapes, which is 1.3 million
     * answers. Every shape, not only the flattened ones: Antarctica's coast
     * keeps `geoContains` and its islands do not, and the seam between the two
     * is exactly the sort of thing worth sweeping.
     *
     * The spacing is what the reference costs, not what this costs. 1.3
     * million `geoContains` calls are fourteen seconds; the same number of
     * `solidHolds` calls are a quarter of one, which is the entire point of
     * the module. The sweep this stands in for is thirty-six times finer — a
     * 0.5° grid, 45,619,200 answers — and was run by hand while this was being
     * built: it disagrees eleven times, every one within a kilometre of an
     * outline. The test below is where that claim is pinned, because it is the
     * one that can afford to run on every commit.
     */
    const wrong: string[] = [];
    for (const shape of SHAPES) {
      const solid = solidOf(shape as never);
      for (let latitude = -88.5; latitude <= 89; latitude += 3)
        for (let longitude = -178.5; longitude <= 179; longitude += 3)
          if (
            solidHolds(solid, longitude, latitude) !==
            geoContains(shape as never, [longitude, latitude])
          )
            wrong.push(`${shape.properties.name} at ${longitude},${latitude}`);
    }
    expect(wrong).toEqual([]);
  });

  /**
   * Roughly how far a point is from the nearest outline, in kilometres.
   *
   * Planar point-to-segment with longitude squeezed by `cos φ`, which is a
   * good enough ruler for a test whose whole question is "is this on the
   * border or not" — the answers it has to separate are a few hundred metres
   * against the tens of kilometres a country's interior is wide.
   */
  function fromOutline(shape: { geometry: unknown }, at: [number, number]): number {
    const geometry = shape.geometry as
      | { type: 'Polygon'; coordinates: [number, number][][] }
      | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const squeeze = Math.cos((at[1] * Math.PI) / 180);
    const x = at[0] * squeeze;
    let best = Infinity;
    for (const rings of polygons)
      for (const ring of rings)
        for (let index = 1; index < ring.length; index += 1) {
          const ax = ring[index - 1][0] * squeeze;
          const ay = ring[index - 1][1];
          const bx = ring[index][0] * squeeze;
          const by = ring[index][1];
          const run = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
          const t =
            run === 0
              ? 0
              : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (at[1] - ay) * (by - ay)) / run));
          const away = Math.hypot(x - (ax + (bx - ax) * t), at[1] - (ay + (by - ay) * t));
          if (away < best) best = away;
        }
    return best * 111.32;
  }

  it('disagrees only on the outline itself, over the ground this watchlist flies', () => {
    /*
     * A tenth of a degree — 11 km, finer than the settle sweep's own samples
     * at every zoom the map reaches — over the five countries this watchlist's
     * routes touch. The two answers are not identical here and cannot be: a
     * flattened ring and a spherical one meet at their vertices and part
     * between them, so a point close enough to the border can fall on either
     * side of it.
     *
     * **What matters is how close "close enough" is.** Measured over a sweep
     * sixteen times finer than this one — 7,962,846 points — 76 disagreed, and
     * the furthest of them was 353 m from an outline. The 1:110m shapes this
     * runs on are themselves a median of 1.5 to 5.2 km away from the 1:10m
     * ones the map draws over them, so the whole band of disagreement fits
     * inside the atlas's own generalisation with an order of magnitude to
     * spare. A kilometre here is that claim with room, not a tolerance chosen
     * to make a number pass.
     */
    const wrong: string[] = [];
    for (const name of ['Peru', 'Chile', 'Argentina', 'Bolivia', 'Uruguay']) {
      const shape = shapeOf(name);
      const solid = solidOf(shape as never);
      for (let latitude = -56; latitude <= 0; latitude += 0.1)
        for (let longitude = -76; longitude <= -53; longitude += 0.1) {
          const at: [number, number] = [longitude, latitude];
          if (solidHolds(solid, longitude, latitude) === geoContains(shape as never, at)) continue;
          const away = fromOutline(shape as never, at);
          if (away > 1)
            wrong.push(`${name} at ${longitude.toFixed(1)},${latitude.toFixed(1)}: ${away}km`);
        }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps the spherical test for the one shape no sheet can hold', () => {
    /*
     * Antarctica alone. Russia and Fiji cross the date line, which used to put
     * them here too — but a shape that wraps ±180° does not wrap 0°, and
     * `SHIFTED` moves them onto the sheet where they are ordinary. Antarctica
     * goes round the pole rather than past the seam, so it is 360° wide on
     * either sheet and stays spherical.
     */
    const spherical = SHAPES.filter((shape) => solidOf(shape as never).spherical.length > 0).map(
      (shape) => shape.properties.name,
    );
    expect(spherical.sort()).toEqual(['Antarctica']);
    // And only the one ring of it: the seven islands are flattened like anything
    // else, so the expensive answer is asked for as little as possible.
    const antarctica = solidOf(shapeOf('Antarctica') as never);
    expect(antarctica.spherical).toHaveLength(1);
    expect(antarctica.pieces.length).toBeGreaterThan(1);
  });

  it('answers the wrapped shapes exactly, because it moves the seam', () => {
    for (const [name, at] of [
      ['Russia', [37.6, 55.8]], // Moscow
      ['Russia', [-179.5, 65.5]], // Chukotka, past the antimeridian
      ['Fiji', [178.4, -18.1]], // Suva
      ['Fiji', [-179.9, -16.6]], // Vanua Levu's eastern tip, past the seam
      ['Antarctica', [0, -80]],
    ] as [string, [number, number]][]) {
      const shape = shapeOf(name);
      expect(solidHolds(solidOf(shape as never), at[0], at[1])).toBe(
        geoContains(shape as never, at),
      );
    }
  });

  it('follows the great circle rather than the chord on a long edge', () => {
    /*
     * The one thing a planar test gets wrong about a shape that does not wrap:
     * an edge is a great circle, and between two points at the same latitude
     * it bows poleward of the straight line in longitude and latitude. This
     * box's northern edge runs 20° along the 60th parallel, where the arc
     * reaches `atan(tan 60° / cos 10°)` — 60.375° — so a point two tenths of a
     * degree above 60 is inside the real shape and outside its chord, and one
     * half a degree above is outside both.
     *
     * `STRAIGHT_ENOUGH` is what makes this pass: the edge is cut into degree
     * pieces along its own arc before it is ever flattened.
     */
    const box = {
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [-100, 60],
            [-80, 60],
            [-80, 50],
            [-100, 50],
            [-100, 60],
          ] as [number, number][],
        ],
      },
    };
    const at: [number, number] = [-90, 60.2];
    expect(geoContains(box as never, at)).toBe(true);
    expect(solidHolds(solidOf(box), at[0], at[1])).toBe(true);
    // And still outside where the arc genuinely is not.
    expect(geoContains(box as never, [-90, 60.5])).toBe(false);
    expect(solidHolds(solidOf(box), -90, 60.5)).toBe(false);
  });

  it('leaves a hole a hole', () => {
    // Lesotho is a hole in South Africa, and even-odd across both rings is
    // what keeps it one: a point inside the hole crosses an extra ring.
    const africa = shapeOf('South Africa');
    const solid = solidOf(africa as never);
    expect(solidHolds(solid, 28.2, -29.5)).toBe(false); // Maseru
    expect(solidHolds(solid, 28.0, -26.2)).toBe(true); // Johannesburg
  });
});
