import { feature } from 'topojson-client';

import type { LngLat } from '@/features/airfare/lib/geo';
import type { SubdivisionsResponse } from '@/shared/api/geography';

/**
 * A country's first-level subdivisions, turned into something drawable once.
 *
 * The rung below the country names. `countries.ts` derives those from outlines
 * that are already bundled and already on screen, which costs nothing; there
 * is no equivalent free ride here. The 1:110m atlas the map carries has no
 * subdivisions in it at all, Natural Earth's 1:50m admin-1 covers nine
 * countries, and its 1:10m is 40 MB — so this arrives from the API, one
 * country at a time, and the web bundle does not grow by a geography file.
 *
 * Converted here rather than in the component because a TopoJSON topology is
 * arcs and deltas and the canvas wants coordinates: doing it once when the
 * country lands is one pass over a few thousand points, and doing it in the
 * render would be that pass sixty times a second for as long as a drag lasts.
 */

/** One subdivision's name, where it goes, and the ground it stands on. */
export type SubdivisionLabel = {
  /**
   * What tells this unit from every other one on the map, which its name does
   * not.
   *
   * Forty-eight names in Natural Earth's admin-1 list belong to more than one
   * country and fifteen countries repeat one inside themselves: Misiones is a
   * province of Argentina and a department of Paraguay 237 km away, Amazonas
   * belongs to four countries, La Paz to three, and Latvia has two Daugavpils
   * five kilometres apart. Once the map fans out across a viewport those pairs
   * are on screen together, and the name alone stopped being an identity.
   *
   * It is the country and this unit's place in that country's own file, so it
   * is stable across frames and across sessions without the served files
   * having to carry an id they do not have. Built here rather than in the
   * render for the reason the whole module exists: once when the country
   * lands, not sixty times a second.
   */
  key: string;
  name: string;
  at: LngLat;
  /** Solid angle in steradians — the same measure `PlaceLabel.area` carries. */
  area: number;
};

export type Subdivisions = {
  /** ISO 3166-1 numeric, so a drawn layer can be matched to the country it belongs to. */
  country: string;
  /** Every internal boundary once, as a `MultiLineString` a `geoPath` can stroke. */
  borders: { type: 'MultiLineString'; coordinates: LngLat[][] } | null;
  /**
   * The country itself at 1:10m, for the fill and the coastline both.
   *
   * The bundled atlas is 1:110m, whose median segment is 63 km — fifteen
   * pixels at 8x and sixty-one at 32x, which is a straight run where there
   * should be a coast. This is the same shape at the resolution the borders
   * inside it already have, and it is one geometry rather than two because a
   * fill and an outline that disagree are worse than either.
   */
  land: { type: 'MultiPolygon'; coordinates: LngLat[][][] } | null;
  labels: SubdivisionLabel[];
};

/**
 * The wire shape as the map wants it, or `null` when there is nothing to draw.
 *
 * `null` covers every way this can come to nothing — a country Natural Earth
 * does not divide, a response that arrived empty, a topology that will not
 * convert — because the map's answer to all of them is the same one: keep the
 * country's own name and draw nothing else. A thrown error here would be an
 * error banner over a map that is working.
 */
export function readSubdivisions(response: SubdivisionsResponse | null): Subdivisions | null {
  if (!response) return null;

  const labels: SubdivisionLabel[] = [];
  for (const [at, label] of (response.labels ?? []).entries()) {
    if (!label?.name || !Array.isArray(label.at) || label.at.length !== 2) continue;
    if (!Number.isFinite(label.area) || label.area <= 0) continue;
    // The position in the served file, not the position among the ones that
    // survived: a unit's key must not change because a neighbour in the same
    // file was malformed.
    labels.push({
      key: `${response.country}:${at}`,
      name: label.name,
      at: [label.at[0], label.at[1]],
      area: label.area,
    });
  }

  let borders: Subdivisions['borders'] = null;
  let land: Subdivisions['land'] = null;
  try {
    const topology = response.borders as
      { objects?: { borders?: unknown; land?: unknown } } | undefined;
    const read = (name: 'borders' | 'land') => {
      const object = topology?.objects?.[name];
      if (!object) return null;
      return (feature(topology as never, object as never) as unknown as { geometry?: unknown })
        .geometry as { type: string; coordinates: unknown } | undefined;
    };

    const line = read('borders');
    if (line?.type === 'MultiLineString' && (line.coordinates as LngLat[][]).length) {
      borders = { type: 'MultiLineString', coordinates: line.coordinates as LngLat[][] };
    }

    const area = read('land');
    // `mergeArcs` yields a Polygon when a country is one piece and a
    // MultiPolygon when it is not, and the map only wants to know one shape.
    if (area?.type === 'MultiPolygon' && (area.coordinates as LngLat[][][]).length) {
      land = { type: 'MultiPolygon', coordinates: area.coordinates as LngLat[][][] };
    } else if (area?.type === 'Polygon' && (area.coordinates as LngLat[][]).length) {
      land = { type: 'MultiPolygon', coordinates: [area.coordinates as LngLat[][]] };
    }
  } catch {
    // A file that will not convert is a build that went wrong, and the map is
    // not the place to find that out. `test_geography.py` is.
    borders = null;
    land = null;
  }

  if (!borders && !land && labels.length === 0) return null;
  return { country: response.country, borders, land, labels };
}
