import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarCurveChart } from '@/features/airfare/ui/CalendarCurveChart';
import type { CalendarCurve, CalendarPoint } from '@/shared/api/fares';

/**
 * The booking horizon, in the DOM.
 *
 * The arithmetic is `lib/calendarCurve.ts`'s and is tested there. What is left
 * for a rendered chart is what a pure function cannot answer: that both ends of
 * the departure axis are written out, that a pointer lands on the departure
 * date under it, that a keyboard reader can walk the horizon without one, and
 * — the reason most of this file exists — that a date with nothing on sale and
 * a date nobody ever asked about are drawn as two different things and never
 * joined by a line.
 */

beforeEach(() => {
  // jsdom measures everything as 0x0 and the chart divides a client coordinate
  // by the measured width. Given a box the size of the viewBox, a clientX is a
  // view unit; at zero the component refuses to track rather than placing the
  // crosshair at infinity.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 760,
    bottom: 284,
    width: 760,
    height: 284,
    toJSON: () => ({}),
  });
});

function point(departureDate: string, price: number | null): CalendarPoint {
  return { departureDate, price };
}

const CURVE: CalendarCurve = {
  capturedAt: '2026-08-19T15:49:46+00:00',
  source: 'google-flights',
  currency: 'USD',
  fromDate: '2026-08-19',
  toDate: '2026-08-23',
  prices: [
    point('2026-08-19', 164.88),
    point('2026-08-20', 119.5),
    point('2026-08-21', 96.2),
    point('2026-08-22', 88.4),
    point('2026-08-23', 41.24),
  ],
};

function chart(props: Partial<Parameters<typeof CalendarCurveChart>[0]> = {}) {
  render(
    <CalendarCurveChart
      curve={CURVE}
      granularity="day"
      label="Cheapest fare for ARI → SCL by departure date"
      {...props}
    />,
  );
  return screen.getByRole('img');
}

describe('the departure axis', () => {
  it('writes both ends of the horizon out, so the domain is stated and not inferred', () => {
    chart();
    expect(screen.getByTestId('axis-from')).toHaveTextContent('19/08/2026');
    expect(screen.getByTestId('axis-to')).toHaveTextContent('23/08/2026');
  });

  it('says in words that this axis is which departure date, not when we looked', () => {
    chart();
    expect(screen.getByText(/Horizontal — which departure date/)).toBeInTheDocument();
    // Every x axis on this panel is made of time, so the caption names the
    // other two rather than leaving the reader to tell them apart by tick
    // label: the near end of this chart's own zoom, and the other chart.
    expect(screen.getByText(/when each plane leaves/)).toBeInTheDocument();
    expect(screen.getByText(/which day you fly/)).toBeInTheDocument();
    expect(screen.getByText(/when we looked/)).toBeInTheDocument();
  });

  it('names the currency the curve itself carries rather than the page default', () => {
    chart({ curve: { ...CURVE, currency: 'PEN' } });
    expect(screen.getByRole('img')).toHaveAccessibleName(/S\/41\.24/);
  });

  it('says when the curve was collected, so a stale one cannot pass for today', () => {
    chart();
    expect(
      screen.getByText(/Collected 19\/08\/2026 15:49 from google-flights/),
    ).toBeInTheDocument();
  });
});

describe('the crosshair', () => {
  it('says nothing until the reader points at it', () => {
    chart();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByText(/Point at the chart/)).toBeInTheDocument();
  });

  it('reads the departure date under the pointer', () => {
    const svg = chart();
    // The plot runs from x=84 to x=744 across five departure dates, so the
    // third sits at 84 + 2/4 * 660 = 414.
    fireEvent.pointerMove(svg, { clientX: 414, clientY: 100 });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('21/08/2026');
    expect(screen.getByRole('status')).toHaveTextContent(
      'departing 21/08/2026. cheapest fare $96.20.',
    );
  });

  it('snaps to the nearest departure date rather than floating between two', () => {
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 100 });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('21/08/2026');
  });

  it('goes away when the pointer does', () => {
    const svg = chart();
    fireEvent.pointerMove(svg, { clientX: 414, clientY: 100 });
    expect(screen.getByTestId('crosshair')).toBeInTheDocument();
    fireEvent.pointerLeave(svg);
    expect(screen.queryByTestId('crosshair')).not.toBeInTheDocument();
  });

  it('walks the horizon for a reader with no pointer at all', () => {
    const svg = chart();
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('19/08/2026');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('20/08/2026');
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('19/08/2026');
  });

  it('tells the keyboard reader there is no next period to step to', () => {
    chart();
    expect(
      screen.getByText(/whole booking horizon is drawn at once, so there is no next or previous/),
    ).toBeInTheDocument();
  });
});

describe('a date with nothing on sale beside a date nobody asked about', () => {
  const GAPPY: CalendarCurve = {
    ...CURVE,
    prices: [
      point('2026-08-19', 164.88),
      // The 20th was answered for and had nothing to sell; the 21st is absent
      // from the row altogether. The 22nd and 23rd are priced again.
      point('2026-08-20', null),
      point('2026-08-22', 88.4),
      point('2026-08-23', 41.24),
    ],
  };

  it('marks the two absences with different glyphs', () => {
    chart({ curve: GAPPY });
    expect(screen.getByTestId('hole-unsold')).toBeInTheDocument();
    expect(screen.getByTestId('hole-unanswered')).toBeInTheDocument();
  });

  it('never joins a line across either of them', () => {
    const { container } = render(
      <CalendarCurveChart curve={GAPPY} granularity="day" label="ARI → SCL" />,
    );
    const curve = container.querySelector('path[class*="curve"]')!;
    /*
     * Five departure dates across the plot's 660 units is one every 165, so
     * every drawn segment must be exactly one step wide. A segment two or three
     * steps wide is a line reaching over an empty day, which is the whole thing
     * this chart must not do — and counting `M`s would not catch it, because a
     * line drawn straight through both gaps is also a single `M`.
     */
    const xs = [...curve.getAttribute('d')!.matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));
    const steps = xs.slice(1).map((x, index) => Math.round(x - xs[index]));
    expect(steps.every((step) => step === 165)).toBe(true);
    // The 22nd and the 23rd are the only adjacent pair left, so that is the
    // only segment there is; the 19th is stranded and gets a dot instead.
    expect(xs).toHaveLength(2);
  });

  it('reads the unsold date as an answer that came back empty', () => {
    const svg = chart({ curve: GAPPY });
    fireEvent.pointerMove(svg, { clientX: 249, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('nothing on sale');
    expect(screen.getByRole('status')).not.toHaveTextContent('$');
  });

  it('reads the missing date as an answer that never came', () => {
    const svg = chart({ curve: GAPPY });
    fireEvent.pointerMove(svg, { clientX: 414, clientY: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('no answer collected');
    expect(screen.getByRole('status')).not.toHaveTextContent('$');
  });

  it('draws no marker on an empty date, because a marker there is a price', () => {
    const svg = chart({ curve: GAPPY });
    fireEvent.pointerMove(svg, { clientX: 414, clientY: 100 });
    const crosshair = screen.getByTestId('crosshair');
    expect(crosshair.querySelector('circle')).toBeNull();
  });
});

describe('the granularity switch', () => {
  /*
   * A fortnight, so week and month both hold more than one departure date and a
   * band has something to span. 19 August 2026 is a Wednesday.
   */
  const FORTNIGHT: CalendarCurve = {
    ...CURVE,
    toDate: '2026-09-01',
    prices: Array.from({ length: 14 }, (_, offset) => {
      const day = 19 + offset;
      const date = day <= 31 ? `2026-08-${day}` : `2026-09-0${day - 31}`;
      return point(date, 100 + offset * 5);
    }),
  };

  it('draws one point per departure date at day', () => {
    const svg = chart({ curve: FORTNIGHT });
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('01/09/2026');
    expect(screen.getByText(/14 departure dates drawn/)).toBeInTheDocument();
  });

  it('bands a week over the departure dates inside it', () => {
    const svg = chart({ curve: FORTNIGHT, granularity: 'week' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent(
      '2026 wk 34, departing 19/08/2026 to 23/08/2026. cheapest fare $100.00 to $120.00, median $110.00, across 5 departure dates.',
    );
  });

  it('names a month rather than numbering it', () => {
    const svg = chart({ curve: FORTNIGHT, granularity: 'month' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('August 2026');
    expect(screen.getByText(/2 months drawn/)).toBeInTheDocument();
  });
});

describe('with nothing to draw', () => {
  it('says the horizon has never been collected rather than drawing an empty chart', () => {
    render(<CalendarCurveChart curve={null} granularity="day" label="ARI → SCL" />);
    expect(screen.getByText(/No booking horizon collected for this route yet/)).toBeInTheDocument();
  });

  it('does not claim a route was never collected while the answer is still coming', () => {
    render(<CalendarCurveChart curve={null} granularity="day" label="ARI → SCL" loading />);
    expect(screen.getByText(/Reading the booking horizon/)).toBeInTheDocument();
  });

  it('counts the two absences apart even when nothing at all was priced', () => {
    render(
      <CalendarCurveChart
        curve={{ ...CURVE, toDate: '2026-08-20', prices: [point('2026-08-19', null)] }}
        granularity="day"
        label="ARI → SCL"
      />,
    );
    expect(
      screen.getByText(/1 day with nothing on sale and 1 never answered for/),
    ).toBeInTheDocument();
  });
});
