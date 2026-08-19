import { describe, expect, it } from 'vitest';

import { CONTINENTS, ZOOM_TAU, approach, splitByHorizon } from '@/features/airfare/lib/globe';
import { facesViewer, greatCircle, type LngLat } from '@/features/airfare/lib/geo';

const LIMA: LngLat = [-77.114444, -12.021944];
const MADRID: LngLat = [-3.567222, 40.498333];
const TOKYO: LngLat = [139.781, 35.553];
const LOOKING_AT_LIMA: [number, number, number] = [77, 12, 0];

describe('splitByHorizon', () => {
  it('leaves an arc whole when all of it faces the viewer', () => {
    const runs = splitByHorizon(greatCircle(LIMA, MADRID).coordinates, LOOKING_AT_LIMA);
    expect(runs).toHaveLength(1);
    expect(runs[0].near).toBe(true);
  });

  it('cuts an arc that goes round the back into near and far stretches', () => {
    // Lima to Tokyo crosses the horizon: the near half should be drawn solid
    // and the far half dimmed, which is what makes the globe read as glass.
    const runs = splitByHorizon(greatCircle(LIMA, TOKYO).coordinates, LOOKING_AT_LIMA);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0].near).toBe(true);
    expect(runs.some((run) => !run.near)).toBe(true);
  });

  it('alternates rather than repeating a side', () => {
    const runs = splitByHorizon(greatCircle(LIMA, TOKYO).coordinates, LOOKING_AT_LIMA);
    for (const [index, run] of runs.entries()) {
      if (index === 0) continue;
      expect(run.near).toBe(!runs[index - 1].near);
    }
  });

  it('makes the two stretches meet at the horizon instead of leaving a gap', () => {
    // A one-pixel hole exactly on the limb reads as a rendering bug, so runs
    // share their boundary point.
    const runs = splitByHorizon(greatCircle(LIMA, TOKYO).coordinates, LOOKING_AT_LIMA);
    for (const [index, run] of runs.entries()) {
      if (index === 0) continue;
      expect(run.points[0]).toEqual(runs[index - 1].points.at(-1));
    }
  });

  it('keeps every sample, so nothing is dropped at a boundary', () => {
    const points = greatCircle(LIMA, TOKYO).coordinates;
    const runs = splitByHorizon(points, LOOKING_AT_LIMA);
    // Each boundary point appears in two runs, so the total is the original
    // count plus one per seam.
    const drawn = runs.reduce((total, run) => total + run.points.length, 0);
    expect(drawn).toBe(points.length + (runs.length - 1));
  });

  it('has nothing to say about an empty arc', () => {
    expect(splitByHorizon([], LOOKING_AT_LIMA)).toEqual([]);
  });

  it('drops a stretch of a single point, which cannot be drawn as a line', () => {
    expect(splitByHorizon([LIMA], LOOKING_AT_LIMA)).toEqual([]);
  });
});

describe('CONTINENTS', () => {
  it('names all seven', () => {
    expect(CONTINENTS).toHaveLength(7);
    expect(CONTINENTS.map((continent) => continent.name)).toContain('South America');
  });

  it('places each one somewhere on the planet', () => {
    for (const { name, at } of CONTINENTS) {
      expect(at[0], `${name} longitude`).toBeGreaterThanOrEqual(-180);
      expect(at[0], `${name} longitude`).toBeLessThanOrEqual(180);
      expect(at[1], `${name} latitude`).toBeGreaterThanOrEqual(-90);
      expect(at[1], `${name} latitude`).toBeLessThanOrEqual(90);
    }
  });

  it('puts South America in view when the globe faces Lima', () => {
    const south = CONTINENTS.find((continent) => continent.name === 'South America')!;
    expect(facesViewer(south.at, LOOKING_AT_LIMA)).toBe(true);
    const asia = CONTINENTS.find((continent) => continent.name === 'Asia')!;
    expect(facesViewer(asia.at, LOOKING_AT_LIMA)).toBe(false);
  });
});

describe('approach', () => {
  /*
   * Applying a wheel notch in full the instant it arrives is what makes zoom
   * feel mechanical however carefully the factor is chosen: a mouse notch is a
   * 22% change, and 22% in one frame is a step. A tile renderer sets a target
   * and animates towards it; so does this.
   */

  it('covers about two thirds of the distance in one time constant', () => {
    expect(approach(1, 2, ZOOM_TAU)).toBeCloseTo(1 + (1 - Math.exp(-1)), 6);
  });

  it('moves only a fraction of the way in a single frame', () => {
    // A 60 Hz frame is 16ms against a 70ms constant, so about a fifth.
    const afterOneFrame = approach(1, 2, 16);
    expect(afterOneFrame).toBeGreaterThan(1.15);
    expect(afterOneFrame).toBeLessThan(1.25);
  });

  it('runs at the same speed whatever the frame rate', () => {
    // Two 8ms frames on a 120 Hz panel must land where one 16ms frame does.
    const oneStep = approach(1, 2, 16);
    const twoSteps = approach(approach(1, 2, 8), 2, 8);
    expect(twoSteps).toBeCloseTo(oneStep, 6);
  });

  it('arrives, rather than forever halving the gap', () => {
    /*
     * An exponential approach never actually reaches its target, and a scale
     * that sits a thousandth away keeps the render loop awake for nothing.
     */
    let value = 1;
    for (let frame = 0; frame < 40; frame += 1) value = approach(value, 2, 16);
    expect(value).toBe(2);
  });

  it('goes down as readily as up', () => {
    expect(approach(4, 1, 16)).toBeLessThan(4);
    expect(approach(4, 1, 16)).toBeGreaterThan(1);
  });

  it('has nothing to do when it is already there', () => {
    expect(approach(2.5, 2.5, 16)).toBe(2.5);
    expect(approach(1, 2, 0)).toBe(1);
  });
});
