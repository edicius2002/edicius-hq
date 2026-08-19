import { describe, expect, it } from 'vitest';

import { ROUTE_COLOURS, routeColour } from '@/features/airfare/lib/palette';

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * How bright a colour actually looks, not how bright its coordinates say it is.
 *
 * The HSL lightness of a blue and a yellow that read as equally bright differ
 * by a third, so HSL is the wrong ruler for "these belong together" — which is
 * the first thing I got wrong here.
 */
function brightness(hex: string): number {
  const channels = rgb(hex).map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Straight-line distance in RGB. Crude, and enough to catch two near-twins. */
function apart(one: string, other: string): number {
  const [r1, g1, b1] = rgb(one);
  const [r2, g2, b2] = rgb(other);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

describe('the route palette', () => {
  it('starts on the app accent, so the first route looks like it belongs here', () => {
    expect(ROUTE_COLOURS[0]).toBe('#d6a65d');
  });

  it('is a family: every colour carries the same weight as the accent', () => {
    // One brighter entry would take over the map on its own, whatever its hue.
    const levels = ROUTE_COLOURS.map(brightness);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.01);
    expect(Math.min(...levels)).toBeGreaterThan(brightness('#d6a65d') - 0.01);
  });

  it('has no two colours a reader would have to squint at', () => {
    for (const [index, colour] of ROUTE_COLOURS.entries()) {
      for (const other of ROUTE_COLOURS.slice(index + 1)) {
        expect(apart(colour, other), `${colour} vs ${other}`).toBeGreaterThan(35);
      }
    }
  });

  it('separates neighbours hardest, since those are the routes read as a pair', () => {
    // The ramp is emitted as a stride across the wheel rather than around it,
    // which is what buys this: in wheel order the smallest neighbouring gap is
    // 41, and here it is over 100.
    for (let index = 1; index < ROUTE_COLOURS.length; index += 1) {
      expect(apart(ROUTE_COLOURS[index - 1], ROUTE_COLOURS[index])).toBeGreaterThan(100);
    }
  });

  it('gives each of the first seven routes its own colour', () => {
    const used = ROUTE_COLOURS.map((_, index) => routeColour(index));
    expect(new Set(used).size).toBe(ROUTE_COLOURS.length);
  });

  it('starts the ramp again rather than running out', () => {
    expect(routeColour(ROUTE_COLOURS.length)).toBe(routeColour(0));
    expect(routeColour(ROUTE_COLOURS.length + 3)).toBe(routeColour(3));
  });

  it('answers for a nonsense index instead of returning nothing', () => {
    expect(routeColour(-1)).toBe(ROUTE_COLOURS[ROUTE_COLOURS.length - 1]);
  });
});
