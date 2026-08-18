import { describe, expect, it } from 'vitest';

import {
  airportPoint,
  facesViewer,
  greatCircle,
  routeGeometries,
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

describe('routeGeometries', () => {
  const airports = new Map([
    ['LIM', LIMA],
    ['MAD', MADRID],
  ]);

  it('resolves a watched route to two points', () => {
    const [geometry] = routeGeometries(
      [{ id: 'LIM-MAD', origin: 'LIM', destination: 'MAD' }],
      airports,
    );
    expect(geometry.from).toEqual(airportPoint(LIMA));
    expect(geometry.toCity).toBe('Madrid');
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
        { id: 'MAD-LIM', origin: 'MAD', destination: 'LIM' },
      ],
      airports,
    ).map((geometry) => geometry.id);
    expect(ids).toEqual(['LIM-MAD', 'MAD-LIM']);
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
