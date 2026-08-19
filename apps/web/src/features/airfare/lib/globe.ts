import { geoPath, type GeoProjection } from 'd3-geo';

import { facesViewer, type LngLat } from '@/features/airfare/lib/geo';

/**
 * Splitting an arc into the part in front of the globe and the part behind it.
 *
 * An orthographic projection maps a point on the far side to its *correct*
 * screen position — the maths drops the depth, it does not mirror. So the far
 * half of an arc can simply be drawn where it falls, dimmed, and the globe
 * reads as translucent: Lima stays on screen when you spin the Pacific towards
 * you, instead of vanishing at the horizon.
 *
 * The alternative was pinning a label to the limb, which says "over there"
 * without showing anything. This shows it.
 */

export type ArcRun = {
  /** `true` when this stretch is on the hemisphere facing the viewer. */
  near: boolean;
  points: LngLat[];
};

/**
 * The arc's samples cut into alternating near and far stretches.
 *
 * Consecutive runs share their boundary point, so the two drawn paths meet at
 * the limb instead of leaving a gap there — a one-pixel hole exactly on the
 * horizon is the kind of thing that reads as a rendering bug.
 */
export function splitByHorizon(points: LngLat[], rotation: [number, number, number]): ArcRun[] {
  if (points.length === 0) return [];

  const runs: ArcRun[] = [];
  let current: ArcRun = { near: facesViewer(points[0], rotation), points: [points[0]] };

  for (const point of points.slice(1)) {
    const near = facesViewer(point, rotation);
    if (near === current.near) {
      current.points.push(point);
      continue;
    }
    // Close the run *through* this point, then start the next one from it.
    current.points.push(point);
    runs.push(current);
    current = { near, points: [point] };
  }
  runs.push(current);
  return runs.filter((run) => run.points.length > 1);
}

/**
 * Where the continents are, for labelling a globe that has no place names.
 *
 * mapcn gets these from its basemap's symbol layers. With a blank style — which
 * this repository requires, since the browser may not fetch tiles — that
 * basemap is gone and so are its labels, for mapcn as much as for us. Seven
 * hand-placed points is the whole of what was lost, and it weighs nothing.
 *
 * Positions are eyeballed centroids of the landmass rather than true
 * geographic centres: a label reads better over the middle of what a person
 * sees than over the average of a coastline that includes the Aleutians.
 */
export const CONTINENTS: { name: string; at: LngLat }[] = [
  { name: 'North America', at: [-100, 45] },
  { name: 'South America', at: [-60, -15] },
  { name: 'Europe', at: [16, 51] },
  { name: 'Africa', at: [20, 4] },
  { name: 'Asia', at: [90, 45] },
  { name: 'Oceania', at: [140, -25] },
  { name: 'Antarctica', at: [10, -78] },
];

/**
 * How far the flat map may be dragged, which is up and down and no further
 * than its own edges.
 *
 * Sideways is left out on purpose: the projection is fitted to the width of
 * the frame, so dragging horizontally only ever swaps map for empty space.
 * Vertically it is genuinely taller than the frame — Mercator stretches the
 * poles — and there is something to reach.
 *
 * When the map is shorter than the frame there is nothing to scroll, so it
 * sits centred rather than floating wherever it was let go.
 */
export function clampVertical(
  mercator: GeoProjection,
  frameHeight: number,
  offset: number,
): number {
  const [[, top], [, bottom]] = geoPath(mercator).bounds({ type: 'Sphere' });
  const height = bottom - top;
  if (height <= frameHeight) return offset - (top + bottom) / 2 + frameHeight / 2;
  // `top` and `bottom` already include the current offset, so the correction
  // is relative to it.
  if (top > 0) return offset - top;
  if (bottom < frameHeight) return offset + (frameHeight - bottom);
  return offset;
}
