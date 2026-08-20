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

describe('a period that is only partly priced', () => {
  /*
   * A fortnight from Wednesday 19 August 2026, with the whole of the second
   * ISO week missing from the row. Week 34 holds five priced departure dates
   * and week 35 holds none, so at Week granularity one period is whole, one is
   * a hole, and the last — two days of September — is whole again.
   */
  const HOLED: CalendarCurve = {
    ...CURVE,
    toDate: '2026-09-01',
    prices: [
      ...Array.from({ length: 5 }, (_, offset) => point(`2026-08-${19 + offset}`, 100 + offset)),
      point('2026-08-31', 140),
      point('2026-09-01', 145),
    ],
  };

  /** The same fortnight, but with only the 26th missing out of week 35. */
  const NICKED: CalendarCurve = {
    ...HOLED,
    prices: [
      ...Array.from({ length: 14 }, (_, offset) => {
        const day = 19 + offset;
        const date = day <= 31 ? `2026-08-${day}` : `2026-09-0${day - 31}`;
        return point(date, 100 + offset);
      }).filter((price) => price.departureDate !== '2026-08-26'),
    ],
  };

  it('marks a week where one departure date was never answered for', () => {
    // The fault: the mark was drawn only where a period held no price at all,
    // which at Week and Month is a minority of the holes there are. A week of
    // seven dates with one missing drew as an ordinary connected point, and the
    // chart built to keep the two absences apart said nothing about either.
    chart({ curve: NICKED, granularity: 'week' });
    expect(screen.getByTestId('hole-unanswered')).toBeInTheDocument();
  });

  it('says which date it was in the tooltip beside the price', () => {
    chart({ curve: NICKED, granularity: 'week' });
    const titles = [...document.querySelectorAll('title')].map((node) => node.textContent ?? '');
    expect(titles.some((text) => text.includes('1 day never answered for'))).toBe(true);
  });

  it('leaves a week with nothing missing unmarked', () => {
    chart({ curve: NICKED, granularity: 'week' });
    // Three weeks are drawn and only the middle one has a date missing.
    expect(screen.getAllByTestId('hole-unanswered')).toHaveLength(1);
  });

  it('still marks a period that holds no price at all', () => {
    chart({ curve: HOLED, granularity: 'week' });
    expect(screen.getAllByTestId('hole-unanswered')).toHaveLength(1);
  });

  it('draws no absence mark at all on a fully priced horizon', () => {
    chart({ curve: CURVE, granularity: 'day' });
    expect(screen.queryByTestId('hole-unanswered')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hole-unsold')).not.toBeInTheDocument();
  });
});

describe('the price axis says only what was quoted', () => {
  it('ticks at round numbers rather than at the padded ends of the domain', () => {
    /*
     * The measured case. This curve runs $41.24 to $196.33; the padding term is
     * 18.61 and the three labels used to be $22.63, $118.79 and $214.94 — not
     * one of them a fare anybody was quoted, all three set in the same money
     * format as the fares that were.
     */
    const { container } = render(
      <CalendarCurveChart
        curve={{
          ...CURVE,
          prices: [
            point('2026-08-19', 196.33),
            point('2026-08-20', 119.5),
            point('2026-08-21', 96.2),
            point('2026-08-22', 88.4),
            point('2026-08-23', 41.24),
          ],
        }}
        granularity="day"
        label="ARI → SCL"
      />,
    );
    const ticks = [...container.querySelectorAll('text')]
      .map((node) => node.textContent ?? '')
      .filter((text) => text.startsWith('$'));
    expect(ticks).toEqual(['$50.00', '$100.00', '$150.00', '$200.00']);
    expect(ticks).not.toContain('$22.63');
    expect(ticks).not.toContain('$118.79');
    expect(ticks).not.toContain('$214.94');
  });

  it('names the range that was priced, not the range that was drawn', () => {
    chart();
    expect(screen.getByRole('img')).toHaveAccessibleName(/from \$41\.24 to \$164\.88\./);
  });
});

describe('the crosshair over a departure date with no figure', () => {
  const GAPPY: CalendarCurve = {
    ...CURVE,
    prices: [point('2026-08-19', 164.88), point('2026-08-20', null), point('2026-08-23', 41.24)],
  };

  it('prints no price at all for a keyboard reader who lands on one', () => {
    // The plate used to print the middle of the padded domain as currency,
    // beside a readout saying `—` and a live region saying "no fare". It is
    // `aria-hidden`, so this was only ever wrong for the sighted reading — and
    // that is not a reason to leave it wrong.
    const svg = chart({ curve: GAPPY });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });

    expect(screen.getByTestId('time-tag-text')).toHaveTextContent('20/08/2026');
    expect(screen.queryByTestId('price-tag-text')).not.toBeInTheDocument();
  });

  it('still prints one where the date has a fare to sit on', () => {
    const svg = chart({ curve: GAPPY });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('price-tag-text')).toHaveTextContent('$164.88');
  });

  it('keeps the plate under a pointer, where the height is the reader’s own', () => {
    const svg = chart({ curve: GAPPY });
    fireEvent.pointerMove(svg, { clientX: 249, clientY: 100 });
    expect(screen.getByTestId('price-tag-text')).toBeInTheDocument();
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

  it('says the request failed rather than that nobody ever collected one', () => {
    // `isPending` is false on a failed query, so the page used to render a 500
    // from `/api/fares/calendar` as "no booking horizon collected for this
    // route yet" — a fault at our end reported as a fact about the route.
    render(
      <CalendarCurveChart
        curve={null}
        granularity="day"
        label="ARI → SCL"
        error={new Error('fares upstream refused the request')}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /booking horizon could not be read: fares upstream refused the request/,
    );
    expect(screen.queryByText(/No booking horizon collected/)).not.toBeInTheDocument();
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
