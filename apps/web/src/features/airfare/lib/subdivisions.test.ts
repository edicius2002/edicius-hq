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
    objects: {
      borders: { type: 'MultiLineString', arcs: [[0]] },
      land: { type: 'MultiPolygon', arcs: [[[1]]] },
    },
    arcs: [
      [
        [-76, -6],
        [-74, -8],
        [-73, -11],
      ],
      [
        [-81, -2],
        [-69, -2],
        [-69, -18],
        [-81, -18],
        [-81, -2],
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
      { key: '604:0', name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 },
      { key: '604:1', name: 'Cusco', at: [-72.1831, -13.1676], area: 0.0018352 },
    ]);
  });

  it('gives two subdivisions of the same name two different keys', () => {
    /*
     * A name is not an identity on this map, and the reader found that out the
     * hard way: forty-eight names in Natural Earth's admin-1 list belong to
     * more than one country and fifteen countries repeat one inside
     * themselves. Misiones is a province of Argentina and a department of
     * Paraguay 237 km away — one frame holds both — and Latvia has two
     * Daugavpils five kilometres apart.
     *
     * The key is the country and the unit's own place in that country's file,
     * so it survives a name that is not unique in either direction, and it is
     * the same key on the next frame and in the next session.
     */
    const both = readSubdivisions({
      ...PERU,
      country: '032',
      labels: [
        { name: 'Misiones', at: [-54.7, -26.9], area: 0.0007 },
        { name: 'Misiones', at: [-57.0, -26.9], area: 0.0002 },
      ],
    });
    expect(both?.labels.map((label) => label.key)).toEqual(['032:0', '032:1']);

    const elsewhere = readSubdivisions({
      ...PERU,
      country: '600',
      labels: [{ name: 'Misiones', at: [-57.0, -26.9], area: 0.0002 }],
    });
    // And across countries, which is the pair a fan-out actually puts on
    // screen together.
    expect(elsewhere?.labels[0].key).not.toBe(both?.labels[0].key);
  });

  it('numbers a key by the served file, not by the labels that survived it', () => {
    // A unit's key must not move because a neighbour in the same file was
    // malformed: the reader's view would change identity under them for a
    // reason that has nothing to do with them.
    const read = readSubdivisions({
      ...PERU,
      labels: [
        { name: 'No area', at: [-74, -4], area: 0 },
        { name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 },
      ],
    });
    expect(read?.labels.map((label) => label.key)).toEqual(['604:1']);
  });

  it('reads the country outline that comes with the borders', () => {
    /*
     * The bundled atlas is 1:110m, whose median segment is 63 km — sixty-one
     * pixels at the 32x ceiling, which is a straight run where a coast should
     * be. This is the same country at the resolution its own provincial
     * borders already have, and it arrives in the same file for that reason:
     * a coast and the borders inside it that came from different sources would
     * not meet.
     */
    const read = readSubdivisions(PERU);
    expect(read?.land?.type).toBe('MultiPolygon');
    expect(read?.land?.coordinates[0][0]).toHaveLength(5);
  });

  it('takes a one-piece country as a MultiPolygon anyway', () => {
    // `mergeArcs` yields a Polygon for a country that is a single piece and a
    // MultiPolygon for one that is not, and the map wants one shape of thing.
    const read = readSubdivisions({
      ...PERU,
      borders: {
        ...(PERU.borders as object),
        objects: {
          borders: { type: 'MultiLineString', arcs: [[0]] },
          land: { type: 'Polygon', arcs: [[1]] },
        },
      },
    });
    expect(read?.land?.type).toBe('MultiPolygon');
    expect(read?.land?.coordinates).toHaveLength(1);
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
