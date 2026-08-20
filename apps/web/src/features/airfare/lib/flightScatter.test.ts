import { describe, expect, it } from 'vitest';

import {
  absentDays,
  activeKey,
  axisDayLabel,
  axisTicks,
  cheapestPath,
  cheapestPerDay,
  clockLabel,
  clockMinutes,
  dayBoundaries,
  dayOffset,
  dayPlus,
  departureDays,
  firstDayIn,
  flightPoints,
  flightSentence,
  minutesInto,
  nearestPlaced,
  periodKeys,
  placePoints,
  priceAt,
  priceSpan,
  scatterWindow,
  stepKey,
  windowDays,
  xOf,
  yOf,
  type Plot,
  type ScatterPoint,
} from '@/features/airfare/lib/flightScatter';
import type { FareOffer, FareSnapshot } from '@/shared/api/fares';

/**
 * The scatter's arithmetic, without a browser.
 *
 * The boundary cases are the ones worth the file. A chart drawn on departure
 * time lives or dies on which period a departure belongs to, and the answer has
 * to be the same answer the table above it gives — so the week here is asserted
 * against the same Monday `buckets.periodBounds` names, and a 23:59 Sunday
 * departure is asserted to be inside it while the 00:00 Monday after it is not.
 */

function offer(overrides: Partial<FareOffer> = {}): FareOffer {
  return {
    airline: 'LA',
    airlineName: 'LATAM',
    flightNumber: '2075',
    departureAt: '2027-03-09T19:55',
    arrivalAt: '2027-03-09T21:15',
    transfers: 0,
    durationMinutes: 80,
    price: 210,
    currency: 'USD',
    ...overrides,
  };
}

function snapshot(flightDate: string, capturedAt: string, offers: FareOffer[] = []): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: 'LIM',
    destination: 'SCL',
    flightDate,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers,
  };
}

const PLOT: Plot = { width: 760, height: 300, pad: { top: 10, right: 20, bottom: 30, left: 80 } };

describe('reading a wall clock off a stamp', () => {
  it('reads minutes past midnight without going through a Date', () => {
    expect(clockMinutes('2027-03-09T00:15')).toBe(15);
    expect(clockMinutes('2027-03-09T19:55')).toBe(1195);
    expect(clockMinutes('2027-03-09T23:59')).toBe(1439);
  });

  it('refuses a stamp with no clock rather than calling it midnight', () => {
    expect(clockMinutes('2027-03-09')).toBeNull();
  });

  it('refuses an hour the clock does not have', () => {
    expect(clockMinutes('2027-03-09T24:00')).toBeNull();
    expect(clockMinutes('2027-03-09Tab:cd')).toBeNull();
  });

  it('counts whole days between two dates across a month end', () => {
    expect(dayOffset('2027-02-27', '2027-03-02')).toBe(3);
    expect(dayOffset('2027-03-09', '2027-03-09')).toBe(0);
    expect(dayPlus('2027-02-27', 2)).toBe('2027-03-01');
  });
});

describe('the window a period covers', () => {
  it('gives a day the whole 1440 minutes even though it ends at 23:59', () => {
    const window = scatterWindow('2027-03-09', 'day');
    expect(window.from).toBe('2027-03-09T00:00');
    expect(window.to).toBe('2027-03-09T23:59');
    expect(window.days).toBe(1);
    expect(window.spanMinutes).toBe(1440);
  });

  it('runs a week from Monday 00:00 to Sunday 23:59', () => {
    const window = scatterWindow('2027-W10', 'week');
    expect(window.from).toBe('2027-03-08T00:00');
    expect(window.to).toBe('2027-03-14T23:59');
    expect(window.days).toBe(7);
  });

  it('asks the calendar how long a month is rather than a table of twelve', () => {
    expect(scatterWindow('2028-02', 'month').days).toBe(29);
    expect(scatterWindow('2027-02', 'month').days).toBe(28);
    expect(scatterWindow('2027-03', 'month').days).toBe(31);
  });
});

describe('which period a departure belongs to', () => {
  const week = scatterWindow('2027-W10', 'week');

  it('keeps a flight departing at 23:59 on the Sunday inside that week', () => {
    expect(minutesInto(week, '2027-03-14T23:59')).toBe(6 * 1440 + 1439);
  });

  it('puts the flight departing at 00:00 on the Monday after into the next week', () => {
    expect(minutesInto(week, '2027-03-15T00:00')).toBeNull();
    expect(minutesInto(scatterWindow('2027-W11', 'week'), '2027-03-15T00:00')).toBe(0);
  });

  it('keeps the flight departing at 00:00 on the Monday itself', () => {
    expect(minutesInto(week, '2027-03-08T00:00')).toBe(0);
  });

  it('drops the flight departing at 23:59 on the Sunday before', () => {
    expect(minutesInto(week, '2027-03-07T23:59')).toBeNull();
  });

  it('ignores seconds rather than letting them fall past the last minute', () => {
    expect(minutesInto(week, '2027-03-14T23:59:30')).toBe(6 * 1440 + 1439);
  });

  it('refuses a stamp too short to carry a clock', () => {
    expect(minutesInto(week, '2027-03-09')).toBeNull();
  });
});

describe('one point per itinerary', () => {
  const window = scatterWindow('2027-03', 'month');

  const snapshots = [
    snapshot('2027-03-09', '2026-08-01T09:00', [
      offer({ price: 400, flightNumber: '1' }),
      offer({ price: 300, flightNumber: '2', departureAt: '2027-03-09T06:30' }),
    ]),
    // The same departure, looked at again: only the newer board is drawn.
    snapshot('2027-03-09', '2026-08-02T09:00', [
      offer({ price: 210, flightNumber: '1' }),
      offer({ price: 260, flightNumber: '2', departureAt: '2027-03-09T06:30' }),
    ]),
    snapshot('2027-03-10', '2026-08-01T10:00', [
      offer({ price: 190, flightNumber: '3', departureAt: '2027-03-10T08:00' }),
    ]),
  ];

  it('draws each departure day as its board was last seen, not once per collection', () => {
    const points = flightPoints(snapshots, window);
    expect(points).toHaveLength(3);
    expect(points.map((point) => point.price).sort((a, b) => a - b)).toEqual([190, 210, 260]);
  });

  it('places a point at its departure minute inside the window', () => {
    const points = flightPoints(snapshots, window);
    const evening = points.find((point) => point.clock === '19:55');
    expect(evening?.offset).toBe(8 * 1440 + 19 * 60 + 55);
  });

  it('flags the cheapest flight of each day and no other', () => {
    const flagged = cheapestPerDay(flightPoints(snapshots, window));
    expect(flagged.map((point) => `${point.day} ${point.clock}`)).toEqual([
      '2027-03-09 19:55',
      '2027-03-10 08:00',
    ]);
  });

  it('gives a tied day one cheapest flight, the earlier departure', () => {
    const tied = flightPoints(
      [
        snapshot('2027-03-09', '2026-08-01T09:00', [
          offer({ price: 210, flightNumber: '9', departureAt: '2027-03-09T22:00' }),
          offer({ price: 210, flightNumber: '8', departureAt: '2027-03-09T07:00' }),
        ]),
      ],
      window,
    );
    expect(tied.filter((point) => point.cheapestOfDay).map((point) => point.clock)).toEqual([
      '07:00',
    ]);
  });

  it('draws one dot for a board that offers the same itinerary twice', () => {
    const points = flightPoints(
      [
        snapshot('2027-03-09', '2026-08-01T09:00', [
          offer({ price: 310, flightNumber: '7' }),
          offer({ price: 288, flightNumber: '7' }),
        ]),
      ],
      window,
    );
    expect(points).toHaveLength(1);
    expect(points[0].price).toBe(288);
  });

  it('drops a flight with no clock rather than drawing it at midnight', () => {
    const points = flightPoints(
      [snapshot('2027-03-09', '2026-08-01T09:00', [offer({ departureAt: '2027-03-09' })])],
      window,
    );
    expect(points).toEqual([]);
  });

  it('leaves out the departures the window does not cover', () => {
    const points = flightPoints(snapshots, scatterWindow('2027-03-10', 'day'));
    expect(points.map((point) => point.day)).toEqual(['2027-03-10']);
  });
});

describe('choosing which period to draw', () => {
  const snapshots = [
    snapshot('2027-03-02', '2026-08-01T09:00', [offer({ departureAt: '2027-03-02T08:00' })]),
    snapshot('2027-03-09', '2026-08-01T09:00', [offer({ departureAt: '2027-03-09T08:00' })]),
    snapshot('2027-03-24', '2026-08-01T09:00', [offer({ departureAt: '2027-03-24T08:00' })]),
    // A day the collector reached and found nothing on.
    snapshot('2027-03-25', '2026-08-01T09:00', []),
  ];

  it('offers only the days a flight was actually seen departing on', () => {
    expect(departureDays(snapshots)).toEqual(['2027-03-02', '2027-03-09', '2027-03-24']);
  });

  it('groups those days into the same weeks the price chart buckets by', () => {
    expect(periodKeys(departureDays(snapshots), 'week')).toEqual([
      '2027-W09',
      '2027-W10',
      '2027-W12',
    ]);
    expect(periodKeys(departureDays(snapshots), 'month')).toEqual(['2027-03']);
  });

  it('keeps the reader on the same day when the granularity switch moves', () => {
    const keys = periodKeys(departureDays(snapshots), 'week');
    expect(activeKey(keys, 'week', '2027-03-09')).toBe('2027-W10');
    expect(activeKey(periodKeys(departureDays(snapshots), 'day'), 'day', '2027-03-09')).toBe(
      '2027-03-09',
    );
  });

  it('falls back to the earliest period when the anchor means nothing here', () => {
    const keys = periodKeys(departureDays(snapshots), 'week');
    expect(activeKey(keys, 'week', '2029-01-01')).toBe('2027-W09');
    expect(activeKey([], 'week', '2027-03-09')).toBeNull();
  });

  it('steps to the next period that holds flights, skipping the empty week between', () => {
    const keys = periodKeys(departureDays(snapshots), 'week');
    expect(stepKey(keys, '2027-W10', 1)).toBe('2027-W12');
    expect(stepKey(keys, '2027-W09', -1)).toBeNull();
  });

  it('anchors a step on a real departure day rather than on the period start', () => {
    const days = departureDays(snapshots);
    // The Monday of week 12 is the 22nd, and nothing departs that day.
    expect(firstDayIn(days, '2027-W12', 'week')).toBe('2027-03-24');
  });
});

describe('the scales', () => {
  const window = scatterWindow('2027-03-09', 'day');

  it('never anchors the price axis at zero', () => {
    const span = priceSpan([point(210), point(380)])!;
    expect(span.low).toBeGreaterThan(150);
    expect(span.high).toBeGreaterThan(380);
  });

  it('gives a board where every flight costs the same a band to sit in', () => {
    const span = priceSpan([point(210), point(210)])!;
    expect(span.high).toBeGreaterThan(span.low);
  });

  it('has nothing to say about an empty board', () => {
    expect(priceSpan([])).toBeNull();
  });

  it('places midnight on the left edge of the plot and 23:59 just short of the right', () => {
    expect(xOf(0, window, PLOT)).toBe(PLOT.pad.left);
    const right = PLOT.width - PLOT.pad.right;
    expect(xOf(1439, window, PLOT)).toBeLessThan(right);
    expect(xOf(1439, window, PLOT)).toBeGreaterThan(right - 1);
  });

  it('reads a vertical position back as the price it stands for', () => {
    const span = { low: 200, high: 400 };
    expect(priceAt(yOf(300, span, PLOT), span, PLOT)).toBeCloseTo(300, 6);
  });

  it('reports the end of the band rather than a fare above the chart', () => {
    const span = { low: 200, high: 400 };
    expect(priceAt(-50, span, PLOT)).toBe(400);
    expect(priceAt(PLOT.height + 50, span, PLOT)).toBe(200);
  });
});

describe('the dashed line through the cheapest flight of each day', () => {
  const window = scatterWindow('2027-W10', 'week');
  const span = { low: 150, high: 450 };

  /**
   * Seven departure days across the plot's 660 usable units, so one day is 94.3
   * of them. Every honest segment of this line is exactly that wide: its nodes
   * are one per day, and they are all drawn at the same hour in these fixtures
   * so the width is the calendar step and nothing else.
   */
  const DAY_WIDTH = 660 / 7;

  /** A day's board, every flight at a whole hour from 06:00 so the clock is not the variable. */
  function board(day: string, prices: number[]): FareSnapshot {
    return snapshot(
      day,
      '2026-08-01T09:00',
      prices.map((price, index) =>
        offer({
          price,
          departureAt: `${day}T${String(6 + index).padStart(2, '0')}:00`,
          flightNumber: `${day}-${index}`,
        }),
      ),
    );
  }

  /**
   * How far each drawn segment reaches, horizontally.
   *
   * Widths rather than a count of subpaths, and that is the whole reason this
   * helper exists: counting `M`s does not catch a line running through a hole.
   * A single stroke straight across a missing day is one `M` exactly like a
   * single stroke across a step, and the two are told apart only by how far one
   * of their segments reaches. A segment that starts a new stroke draws nothing
   * and is skipped.
   */
  function segments(path: string): number[] {
    const nodes = [...path.matchAll(/([ML])(-?[\d.]+),/g)];
    const widths: number[] = [];
    for (let index = 1; index < nodes.length; index += 1) {
      if (nodes[index][1] !== 'L') continue;
      widths.push(Number(nodes[index][2]) - Number(nodes[index - 1][2]));
    }
    return widths;
  }

  const RUN = [board('2027-03-09', [380, 210]), board('2027-03-10', [260])];
  const points = flightPoints(RUN, window);

  it('joins one node per day, in departure order', () => {
    expect(cheapestPath(points, window, span, PLOT).match(/[ML]/g)).toEqual(['M', 'L']);
  });

  it('passes through the cheapest flight itself, at the hour it leaves', () => {
    const cheapest = cheapestPerDay(points)[0];
    const path = cheapestPath(points, window, span, PLOT);
    expect(path.startsWith(`M${xOf(cheapest.offset, window, PLOT).toFixed(1)},`)).toBe(true);
  });

  it('stops at a departure day nobody ever collected rather than reaching across it', () => {
    // The 8th and 9th were collected, the 10th never was, the 11th and 12th
    // were. A line through the lot claims a fare moved evenly across a day
    // nobody has ever priced.
    const path = cheapestPath(
      flightPoints(
        [
          board('2027-03-08', [240]),
          board('2027-03-09', [210]),
          board('2027-03-11', [260]),
          board('2027-03-12', [255]),
        ],
        window,
      ),
      window,
      span,
      PLOT,
    );

    // The assertion that catches the old drawing, and it has to be this one:
    // counting subpaths does not, because a single stroke straight through the
    // missing day is one `M` exactly like a single stroke across a step.
    // Nothing this line draws may reach further than one departure day.
    expect(Math.max(...segments(path))).toBeLessThan(1.5 * DAY_WIDTH);
    expect(segments(path)).toHaveLength(2);
    for (const width of segments(path)) expect(width).toBeCloseTo(DAY_WIDTH, 0);
  });

  it('stops at a departure day whose board came back empty, the same as at one nobody asked about', () => {
    // The 10th was asked about and had nothing to sell. That is a different
    // fact from never having asked — the rail under the plot says which — but
    // it is the same hole as far as the line is concerned, because there is no
    // cheapest flight to draw through.
    const path = cheapestPath(
      flightPoints(
        [
          board('2027-03-08', [240]),
          board('2027-03-09', [210]),
          board('2027-03-10', []),
          board('2027-03-11', [260]),
          board('2027-03-12', [255]),
        ],
        window,
      ),
      window,
      span,
      PLOT,
    );

    expect(Math.max(...segments(path))).toBeLessThan(1.5 * DAY_WIDTH);
    expect(segments(path)).toHaveLength(2);
  });

  it('leaves a day stranded between two holes out of the line altogether', () => {
    // A run of one node has no line in it. The component rings every
    // cheapest-of-day flight, so the day is still marked.
    const path = cheapestPath(
      flightPoints([board('2027-03-08', [240]), board('2027-03-12', [255])], window),
      window,
      span,
      PLOT,
    );
    expect(path).toBe('');
  });

  it('draws nothing when a single day cannot make a line', () => {
    const oneDay = scatterWindow('2027-03-09', 'day');
    const onePoints = flightPoints([board('2027-03-09', [380, 210])], oneDay);
    expect(cheapestPerDay(onePoints)).toHaveLength(1);
    expect(cheapestPath(onePoints, oneDay, span, PLOT)).toBe('');
  });
});

describe('which departure days the frame covers', () => {
  it('walks every date a window holds, holes included', () => {
    expect(windowDays(scatterWindow('2027-W10', 'week'))).toEqual([
      '2027-03-08',
      '2027-03-09',
      '2027-03-10',
      '2027-03-11',
      '2027-03-12',
      '2027-03-13',
      '2027-03-14',
    ]);
    expect(windowDays(scatterWindow('2027-03-09', 'day'))).toEqual(['2027-03-09']);
  });

  it('clips a week that runs past the end of the watched month', () => {
    // March 2027's last ISO week is 29 March to 4 April. A month watch has
    // never asked about April, so the frame must not draw four days of it.
    const week = scatterWindow('2027-W13', 'week', { from: '2027-03-01', to: '2027-03-31' });
    expect(week.from).toBe('2027-03-29T00:00');
    expect(week.to).toBe('2027-03-31T23:59');
    expect(week.days).toBe(3);
    expect(axisTicks(week).map((tick) => tick.label)).toEqual(['29/03', '30/03', '31/03']);
    expect(dayBoundaries(week)).toHaveLength(2);
  });

  it('clips a week that starts before the watched month begins', () => {
    // 1 March 2027 is a Monday, so no week overhangs the front of that month —
    // but April's first week runs from 29 March, and an April watch has no more
    // business drawing March than a March one has drawing April.
    const week = scatterWindow('2027-W13', 'week', { from: '2027-04-01', to: '2027-04-30' });
    expect(week.from).toBe('2027-04-01T00:00');
    expect(week.to).toBe('2027-04-04T23:59');
    expect(week.days).toBe(4);
  });

  it('leaves a period wholly inside the watch exactly as it was', () => {
    const week = scatterWindow('2027-W10', 'week', { from: '2027-03-01', to: '2027-03-31' });
    expect(week.from).toBe('2027-03-08T00:00');
    expect(week.to).toBe('2027-03-14T23:59');
    expect(week.days).toBe(7);
  });

  it('keeps its own bounds where the watch and the period do not meet at all', () => {
    // `activeKey` only ever hands over a period a departure day fell in, so
    // this should not arise — and collapsing the frame to nothing rather than
    // saying so would be a chart with no width.
    const week = scatterWindow('2027-W10', 'week', { from: '2027-06-01', to: '2027-06-30' });
    expect(week.days).toBe(7);
  });
});

describe('a departure day inside the frame with no flight on it', () => {
  const window = scatterWindow('2027-W10', 'week');

  const snapshots = [
    snapshot('2027-03-08', '2026-08-01T09:00', [
      offer({ price: 240, departureAt: '2027-03-08T07:00', flightNumber: '1' }),
    ]),
    // Asked about, and the provider had nothing to sell.
    snapshot('2027-03-09', '2026-08-01T09:00', []),
    // The 10th to the 14th were never asked about at all.
  ];

  it('tells a board that came back empty from a day nobody asked about', () => {
    const marks = absentDays(snapshots, window);
    expect(marks.map((mark) => mark.day)).toEqual([
      '2027-03-09',
      '2027-03-10',
      '2027-03-11',
      '2027-03-12',
      '2027-03-13',
      '2027-03-14',
    ]);
    expect(marks.find((mark) => mark.day === '2027-03-09')!.answered).toBe(true);
    expect(marks.filter((mark) => mark.answered)).toHaveLength(1);
  });

  it('says nothing about a day that has flights on it', () => {
    expect(absentDays(snapshots, window).some((mark) => mark.day === '2027-03-08')).toBe(false);
  });

  it('places a mark in the middle of its own day rather than on the midnight beside it', () => {
    const mark = absentDays(snapshots, window).find((day) => day.day === '2027-03-09')!;
    // Day one of the window, plus half a day.
    expect(mark.offset).toBe(1440 + 720);
  });
});

describe('the x axis at each scale', () => {
  it('reads as a clock on a day, ticked every three hours', () => {
    const ticks = axisTicks(scatterWindow('2027-03-09', 'day'));
    expect(ticks).toHaveLength(8);
    expect(ticks[0].label).toBe('00:00');
    expect(ticks.at(-1)!.label).toBe('21:00');
    expect(dayBoundaries(scatterWindow('2027-03-09', 'day'))).toEqual([]);
  });

  it('reads as seven days on a week, one label each', () => {
    const ticks = axisTicks(scatterWindow('2027-W10', 'week'));
    expect(ticks.map((tick) => tick.label)).toEqual([
      '08/03',
      '09/03',
      '10/03',
      '11/03',
      '12/03',
      '13/03',
      '14/03',
    ]);
  });

  it('labels every fifth day on a month but separates every one of them', () => {
    const window = scatterWindow('2027-03', 'month');
    expect(axisTicks(window).map((tick) => tick.label)).toEqual([
      '01/03',
      '06/03',
      '11/03',
      '16/03',
      '21/03',
      '26/03',
      '31/03',
    ]);
    expect(dayBoundaries(window)).toHaveLength(30);
  });

  it('writes a day without its year, and an hour with its leading zero', () => {
    expect(axisDayLabel('2027-03-09')).toBe('09/03');
    expect(clockLabel(180)).toBe('03:00');
    expect(clockLabel(0)).toBe('00:00');
  });
});

describe('the point under the pointer', () => {
  const window = scatterWindow('2027-03-09', 'day');
  const span = { low: 150, high: 450 };
  const points = flightPoints(
    [
      snapshot('2027-03-09', '2026-08-01T09:00', [
        offer({ price: 210, departureAt: '2027-03-09T07:00', flightNumber: '1' }),
        offer({ price: 400, departureAt: '2027-03-09T07:00', flightNumber: '2' }),
      ]),
    ],
    window,
  );
  const placed = placePoints(points, window, span, PLOT);

  it('tells apart two flights leaving at the same minute for different money', () => {
    const cheap = placed.find((entry) => entry.point.price === 210)!;
    const dear = placed.find((entry) => entry.point.price === 400)!;
    expect(cheap.x).toBe(dear.x);
    expect(placed[nearestPlaced(placed, cheap.x, cheap.y)!].point.price).toBe(210);
    expect(placed[nearestPlaced(placed, dear.x, dear.y)!].point.price).toBe(400);
  });

  it('has nothing to point at on an empty plot', () => {
    expect(nearestPlaced([], 100, 100)).toBeNull();
  });

  it('says the whole flight out loud, with its money through the app formatter', () => {
    const cheapest = points.find((entry) => entry.cheapestOfDay)!;
    expect(flightSentence(cheapest, 'USD')).toBe(
      'LA 1, LATAM. departs 09/03/2027 07:00. Direct. 1h 20m. $210.00. cheapest flight of its day.',
    );
  });
});

function point(price: number): ScatterPoint {
  return {
    key: `k${price}`,
    departureAt: '2027-03-09T07:00',
    day: '2027-03-09',
    clock: '07:00',
    offset: 420,
    price,
    currency: 'USD',
    airline: 'LA',
    airlineName: 'LATAM',
    flightNumber: '1',
    transfers: 0,
    durationMinutes: 80,
    cheapestOfDay: false,
  };
}
