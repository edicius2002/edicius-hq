import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectMonths } from '@/features/greenlight/lib/compound';
import { CURVE_VIEW, curveLayout, monthAtView } from '@/features/greenlight/lib/compoundCurve';
import { CompoundCurve } from '@/features/greenlight/ui/CompoundCurve';

/**
 * The crosshair, in the DOM.
 *
 * The arithmetic is pinned in `lib/compoundCurve.test.ts`; what is left for a
 * rendered chart is the part a pure function cannot answer — that a pointer at
 * a client coordinate lands on the month it is over.
 *
 * **Every box below is deliberately a different shape from the viewBox.** jsdom
 * measures every element as 0x0, so the box has to be mocked, and mocking it as
 * exactly the viewBox is what hid this same bug in the airfare slice for as
 * long as it was there: the two shapes agreeing makes the conversion the
 * identity, and an identity is exactly what the wrong formula also produces.
 */

const CAPITAL = 20377.8;
const ROWS = projectMonths(CAPITAL, 6);
const LAYOUT = curveLayout(ROWS, CAPITAL);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mock the box, and hand back where `xMidYMid meet` puts the drawing inside it. */
function boxOf(width: number, height: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  });
  const scale = Math.min(width / CURVE_VIEW.width, height / CURVE_VIEW.height);
  return {
    scale,
    padX: (width - CURVE_VIEW.width * scale) / 2,
    padY: (height - CURVE_VIEW.height * scale) / 2,
    /** The client x a reader has to press to be over this month. */
    clientXOf: (month: number) =>
      (width - CURVE_VIEW.width * scale) / 2 + LAYOUT.xAt(month) * scale,
    /** What the formula this repository stopped using would have read there. */
    naive: (clientX: number) => (clientX / width) * CURVE_VIEW.width,
  };
}

function curve() {
  render(<CompoundCurve rows={ROWS} capital={CAPITAL} currency="USD" />);
  return screen.getByRole('img');
}

describe('at rest', () => {
  it('reads month 60 before anybody has touched it', () => {
    boxOf(1280, 360);
    curve();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Month 60');
    expect(status).toHaveTextContent('$27,486.60');
    expect(status).toHaveTextContent('+$7,108.80 earned');
  });

  it('says nothing to project when there is nothing to project', () => {
    render(<CompoundCurve rows={[]} capital={0} currency="USD" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Nothing to project yet.')).toBeInTheDocument();
  });
});

describe('a box the drawing does not fill', () => {
  it('reads the month the pointer is over in a box wider than the drawing', () => {
    // 320 units of pillarbox a side. Pressing exactly on month 60 has to read
    // month 60 — dividing by the box's own width instead reads month 54, and
    // the error grows the further from the centre the hand goes.
    const place = boxOf(1280, 360);
    expect(place.padX).toBe(320);
    expect(place.padY).toBe(0);

    const svg = curve();
    fireEvent.pointerMove(svg, { clientX: place.clientXOf(60), clientY: 180 });
    expect(screen.getByRole('status')).toHaveTextContent('Month 60');
  });

  it('is off by sixty months at the far end of that box, which is what was fixed', () => {
    const place = boxOf(1280, 360);
    const svg = curve();
    const clientX = place.clientXOf(120);

    fireEvent.pointerMove(svg, { clientX, clientY: 180 });
    expect(screen.getByRole('status')).toHaveTextContent('Month 120');
    expect(screen.getByRole('status')).toHaveTextContent('$37,075.30');

    // The old formula on the same press, spelled out rather than described:
    // 470 view units, which is month 84, where the hand is on month 120. Left
    // as an assertion so a regression to it is a red test and not a shrug.
    expect(place.naive(clientX)).toBeCloseTo(470, 0);
    expect(monthAtView(place.naive(clientX), ROWS.length, LAYOUT.step)).toBe(84);
  });

  it('reads the first month at the left edge rather than a month either side of it', () => {
    const place = boxOf(1280, 360);
    const svg = curve();
    fireEvent.pointerMove(svg, { clientX: place.clientXOf(1), clientY: 180 });
    expect(screen.getByRole('status')).toHaveTextContent('Month 1');
    expect(screen.getByRole('status')).toHaveTextContent('$20,479.69');
    // The old formula reads month 25 for a hand resting on month 1.
    expect(monthAtView(place.naive(place.clientXOf(1)), ROWS.length, LAYOUT.step)).toBe(25);
  });

  it('is unchanged in a box taller than the drawing, where the bars are horizontal', () => {
    // Letterboxed: no horizontal bar, so the old formula and this one agree.
    // Included because which way a box boxes is a fact about the column this
    // chart lands in and not about the chart, and both cases are reachable.
    const place = boxOf(640, 900);
    expect(place.padX).toBe(0);
    expect(place.padY).toBe(270);

    const svg = curve();
    fireEvent.pointerMove(svg, { clientX: place.clientXOf(24), clientY: 450 });
    expect(screen.getByRole('status')).toHaveTextContent('Month 24');
  });

  it('refuses to track in a box with no area, rather than placing the hair at infinity', () => {
    boxOf(0, 0);
    const svg = curve();
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 180 });
    expect(screen.getByRole('status')).toHaveTextContent('Month 60');
  });
});

describe('without a pointer', () => {
  it('walks a month at a time and a year at a jump', () => {
    boxOf(1280, 360);
    const svg = curve();

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 61');

    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 59');

    fireEvent.keyDown(svg, { key: 'PageUp' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 71');
  });

  it('stops at both ends of the series', () => {
    boxOf(1280, 360);
    const svg = curve();

    fireEvent.keyDown(svg, { key: 'Home' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 1');
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 1');

    fireEvent.keyDown(svg, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 120');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 120');
  });

  it('leaves keys it does not use to the page', () => {
    boxOf(1280, 360);
    const svg = curve();
    fireEvent.keyDown(svg, { key: 'a' });
    expect(screen.getByRole('status')).toHaveTextContent('Month 60');
  });
});
