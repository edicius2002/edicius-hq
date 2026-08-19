import { describe, expect, it } from 'vitest';

import { readSubdivisions } from '@/features/airfare/lib/subdivisions';
import type { SubdivisionsResponse } from '@/shared/api/geography';

/**
 * Reading one country's subdivisions off the wire.
 *
 * The rule this whole file exists to keep is that nothing here throws. A map
 * that is drawing arcs, airports and country names perfectly must not put an
 * error banner over itself because a decorative third layer came back oddly —
 * so every way this can fail resolves to "there is nothing to draw", which is
 * exactly what a country Natural Earth does not divide also resolves to.
 */

/** Two departments and the border between them, in the shape the API sends. */
const PERU: SubdivisionsResponse = {
  country: '604',
  borders: {
    type: 'Topology',
    objects: { borders: { type: 'MultiLineString', arcs: [[0]] } },
    arcs: [
      [
        [-76, -6],
        [-74, -8],
        [-73, -11],
      ],
    ],
  },
  labels: [
    { name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 },
    { name: 'Cusco', at: [-72.1831, -13.1676], area: 0.0018352 },
  ],
};

describe('readSubdivisions', () => {
  it('turns the topology into a line a projection can stroke', () => {
    /*
     * Once, when the country lands, rather than in the render. A topology is
     * arcs and deltas and the canvas wants coordinates, and doing the walk in
     * the render would be doing it sixty times a second for as long as a drag
     * lasts.
     */
    const read = readSubdivisions(PERU);
    expect(read?.borders?.type).toBe('MultiLineString');
    expect(read?.borders?.coordinates).toEqual([
      [
        [-76, -6],
        [-74, -8],
        [-73, -11],
      ],
    ]);
  });

  it('keeps each name with where it goes and the ground it stands on', () => {
    // The same pair a country label carries, because it goes through the same
    // room test: `at` to place it, `area` to decide whether there is room.
    const read = readSubdivisions(PERU);
    expect(read?.country).toBe('604');
    expect(read?.labels).toEqual([
      { name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 },
      { name: 'Cusco', at: [-72.1831, -13.1676], area: 0.0018352 },
    ]);
  });

  it('has nothing to draw for a country that has no subdivisions', () => {
    // `null` is what `fetchSubdivisions` turns a 404 into, and it has to
    // survive this far as an answer rather than as an absence.
    expect(readSubdivisions(null)).toBeNull();
  });

  it('has nothing to draw when the response is empty in every way that matters', () => {
    expect(readSubdivisions({ country: '604', borders: undefined, labels: [] })).toBeNull();
  });

  it('draws the borders it did get when the labels are unusable', () => {
    /*
     * Half an answer is still an answer. A file whose labels went wrong should
     * cost the reader its names, not its borders — and the other way round.
     */
    const read = readSubdivisions({ ...PERU, labels: undefined as never });
    expect(read?.borders?.coordinates).toHaveLength(1);
    expect(read?.labels).toEqual([]);
  });

  it('drops a label that cannot say where it is or how big it is', () => {
    const read = readSubdivisions({
      ...PERU,
      labels: [
        { name: '', at: [-74, -4], area: 0.01 },
        { name: 'No area', at: [-74, -4], area: 0 },
        { name: 'No place', at: [-74] as never, area: 0.01 },
        { name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 },
      ],
    });
    expect(read?.labels.map((label) => label.name)).toEqual(['Loreto']);
  });

  it('keeps the names when the geometry will not convert, instead of throwing', () => {
    /*
     * A topology that will not read is a build that went wrong, and the map is
     * not where anybody should find that out — `test_geography.py` is. Here it
     * costs the borders and nothing else.
     */
    const read = readSubdivisions({ ...PERU, borders: { objects: { borders: 'not a geometry' } } });
    expect(read?.borders).toBeNull();
    expect(read?.labels).toHaveLength(2);
  });
});
