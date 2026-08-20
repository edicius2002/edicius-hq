import { describe, expect, it } from 'vitest';

import {
  anchorFor,
  curveMarks,
  frameDays,
  framePeriodKeys,
  frameSource,
  isWatched,
  railLabels,
  sourceRuns,
  sourceSeams,
} from '@/features/airfare/lib/departureFrame';
import { scatterWindow } from '@/features/airfare/lib/flightScatter';
import type { CalendarCurve, CalendarPoint } from '@/shared/api/fares';

/**
 * Which archive answers for which departure date, and what that does to the
 * axis.
 *
 * The rule these tests pin is one sentence: inside the watched month the boards
 * answer and the x axis is a clock, outside it the booking horizon answers and
 * the x axis is dates. Everything else here follows from it — that a week is
 * the only view where both are on screen, that a month never mixes, that a day
 * view can never reach the curve at all, and that a curve date is a span across
 * its own date rather than a point at an hour it does not have.
 */

const MARCH: { from: string; to: string } = { from: '2027-03-01', to: '2027-03-31' };

function curve(from: string, to: string, prices: CalendarPoint[]): CalendarCurve {
  return {
    capturedAt: '2026-08-19T15:49:46+00:00',
    source: 'google-flights',
    currency: 'USD',
    fromDate: from,
    toDate: to,
    prices,
  };
}

describe('which archive answers for a departure date', () => {
  it('gives the boards every date inside the watched month', () => {
    const days = frameDays(scatterWindow('2027-W10', 'week'), MARCH);
    expect(days.map((day) => day.source)).toEqual(Array(7).fill('board'));
    expect(frameSource(days)).toBe('boards');
  });

  it('gives the curve every date outside it', () => {
    const days = frameDays(scatterWindow('2027-05', 'month'), MARCH);
    expect(new Set(days.map((day) => day.source))).toEqual(new Set(['curve']));
    expect(frameSource(days)).toBe('curve');
  });

  it('splits a week that straddles the end of the watched month, per day', () => {
    // 2027-W13 runs 29 March to 4 April. Three board dates, four curve dates,
    // and the reader steps across the boundary inside one frame.
    const days = frameDays(scatterWindow('2027-W13', 'week'), MARCH);
    expect(days.map((day) => `${day.day} ${day.source}`)).toEqual([
      '2027-03-29 board',
      '2027-03-30 board',
      '2027-03-31 board',
      '2027-04-01 curve',
      '2027-04-02 curve',
      '2027-04-03 curve',
      '2027-04-04 curve',
    ]);
    expect(frameSource(days)).toBe('mixed');
  });

  it('never mixes inside a calendar month, because a month is watched or it is not', () => {
    // Worth stating rather than leaving to be rediscovered: the mixed case a
    // reader will go looking for at month granularity does not exist.
    for (const key of ['2027-03', '2027-04', '2027-02']) {
      const days = frameDays(scatterWindow(key, 'month'), MARCH);
      expect(frameSource(days)).toBe(key === '2027-03' ? 'boards' : 'curve');
    }
  });

  it('hands nothing to the boards where there is no watch to speak for them', () => {
    const days = frameDays(scatterWindow('2027-W10', 'week'), null);
    expect(frameSource(days)).toBe('curve');
    expect(isWatched('2027-03-09', null)).toBe(false);
  });

  it('reads the watch as fixed-width strings rather than parsing a date', () => {
    // A parsed date is midnight UTC and is the previous day in Lima, which
    // would hand the last date of the month to the curve.
    expect(isWatched('2027-03-31', MARCH)).toBe(true);
    expect(isWatched('2027-04-01', MARCH)).toBe(false);
  });
});

describe('where the axis stops being a clock', () => {
  it('puts the seam on the midnight the source changes at', () => {
    const days = frameDays(scatterWindow('2027-W13', 'week'), MARCH);
    // Three board dates, so the boundary is the midnight three days in.
    expect(sourceSeams(days)).toEqual([3 * 1440]);
  });

  it('draws no seam where one archive answers for the whole frame', () => {
    expect(sourceSeams(frameDays(scatterWindow('2027-W10', 'week'), MARCH))).toEqual([]);
  });

  it('draws both seams around a watched range narrower than the frame', () => {
    // Curve dates on each side of the boards, so reporting only the first
    // would draw half the boundary. The page cannot build this range any more
    // — a watch is a whole month since 12.260 — and the rule is still the
    // rule: `frameDays` takes two dates, not a route, and a caller that hands
    // it a narrow pair gets an answer or a defect.
    const focused = { from: '2027-03-10', to: '2027-03-10' };
    const days = frameDays(scatterWindow('2027-W10', 'week'), focused);
    expect(sourceSeams(days)).toEqual([2 * 1440, 3 * 1440]);
  });

  it('cuts the frame into stretches so each can be labelled once', () => {
    const days = frameDays(scatterWindow('2027-W13', 'week'), MARCH);
    expect(sourceRuns(days)).toEqual([
      { source: 'board', from: 0, to: 3 },
      { source: 'curve', from: 3, to: 7 },
    ]);
  });
});

describe('a curve date is a span, not a point', () => {
  const days = frameDays(scatterWindow('2027-W13', 'week'), MARCH);

  it('spans the whole date, because the price is for the whole date', () => {
    const marks = curveMarks(
      days,
      curve('2027-04-01', '2027-04-04', [{ departureDate: '2027-04-01', price: 61.5 }]),
    );
    const first = marks[0];
    expect(first.day).toBe('2027-04-01');
    // The fourth date of the frame: midnight to midnight, 1,440 minutes wide.
    expect(first.from).toBe(3 * 1440);
    expect(first.to).toBe(4 * 1440);
    expect(first.to - first.from).toBe(1440);
  });

  it('sits its rail mark at the middle of the date rather than on a separator', () => {
    const marks = curveMarks(days, curve('2027-04-01', '2027-04-04', []));
    expect(marks[0].centre).toBe(3 * 1440 + 720);
  });

  it('has no marks at all where every date in the frame is a board date', () => {
    const inside = frameDays(scatterWindow('2027-W10', 'week'), MARCH);
    expect(curveMarks(inside, curve('2027-03-01', '2027-12-31', []))).toEqual([]);
  });
});

describe('the two absences a curve date can carry', () => {
  const days = frameDays(scatterWindow('2027-W13', 'week'), MARCH);

  it('reads a null price as answered-and-empty, never as a fare of zero', () => {
    const marks = curveMarks(
      days,
      curve('2027-04-01', '2027-04-04', [{ departureDate: '2027-04-02', price: null }]),
    );
    const second = marks.find((mark) => mark.day === '2027-04-02')!;
    expect(second.price).toBeNull();
    expect(second.answered).toBe(true);
  });

  it('reads a date missing from the row as never answered for', () => {
    const marks = curveMarks(days, curve('2027-04-01', '2027-04-04', []));
    expect(marks.every((mark) => mark.answered === false)).toBe(true);
  });

  it('reads a date the row does not reach as never answered for', () => {
    // A curve that stops on the 2nd says nothing about the 3rd, and a row whose
    // prices reach past its own stated end disagrees with itself.
    const short = curve('2027-04-01', '2027-04-02', [
      { departureDate: '2027-04-01', price: 61.5 },
      { departureDate: '2027-04-03', price: 70 },
    ]);
    const marks = curveMarks(days, short);
    expect(marks.find((mark) => mark.day === '2027-04-03')!.answered).toBe(false);
    expect(marks.find((mark) => mark.day === '2027-04-03')!.price).toBeNull();
  });

  it('says the whole stretch was never answered for where no curve exists at all', () => {
    const marks = curveMarks(days, null);
    expect(marks).toHaveLength(4);
    expect(marks.every((mark) => !mark.answered && mark.price === null)).toBe(true);
  });
});

describe('where the reader can step to', () => {
  const boardDays = ['2027-03-08', '2027-03-09', '2027-03-29'];
  const horizon = curve('2027-03-01', '2027-05-31', []);

  it('bounds the day view to the dates the boards hold', () => {
    // The extreme case the owner ruled out: there is no way to arrive at a day
    // view of a date whose only price is a single timeless number, because the
    // day view cannot reach one.
    expect(framePeriodKeys(boardDays, horizon, 'day')).toEqual(boardDays);
  });

  it('lets a week walk out to wherever the horizon reaches', () => {
    const weeks = framePeriodKeys(boardDays, horizon, 'week');
    expect(weeks[0]).toBe('2027-W09');
    expect(weeks.at(-1)).toBe('2027-W22');
    expect(weeks).toContain('2027-W13');
  });

  it('lets a month walk out the same way', () => {
    expect(framePeriodKeys(boardDays, horizon, 'month')).toEqual(['2027-03', '2027-04', '2027-05']);
  });

  it('has nowhere outside the month to walk to where no horizon is on disk', () => {
    // This is the owner's own LIM-SCL: 681 itineraries and no curve at all. The
    // truthful answer is a shorter walk, not a run of empty frames.
    expect(framePeriodKeys(boardDays, null, 'month')).toEqual(['2027-03']);
  });

  it('anchors a step on a board date where the period has one', () => {
    // So that a later flip to the day view lands on a date that exists there.
    expect(anchorFor('2027-W10', 'week', boardDays)).toBe('2027-03-08');
  });

  it('anchors a step outside the month on the period’s own first date', () => {
    expect(anchorFor('2027-05', 'month', boardDays)).toBe('2027-05-01');
    expect(anchorFor('2027-W17', 'week', boardDays)).toBe('2027-04-26');
  });
});

describe('the rail that says which archive answered where', () => {
  /**
   * The plot the real chart draws in: a 760-unit viewBox less its left margin
   * (`marginForPrices(8)`, which is 84) and its 16 of right padding.
   */
  const TRACK = 660;

  const boxes = (labels: ReturnType<typeof railLabels>) =>
    labels.map((label) => [label.centre - label.width / 2, label.centre + label.width / 2]);

  const disjoint = (labels: ReturnType<typeof railLabels>) =>
    boxes(labels).every(([, to], index) => {
      const next = boxes(labels)[index + 1];
      return next === undefined || next[0] >= to;
    });

  /**
   * The frame the defect was found in, on the owner's own archive.
   *
   * ARI-SCL carried `focusDate: 2027-03-06` at the time, so the page narrowed
   * the boards to that one departure date and the week of 1-7 March was three
   * runs: curve, board, curve. Labelling every run drew a second `one price a
   * date` through the tail of `every flight, at the hour it departs`.
   *
   * **No watch can produce that frame now** — 12.260 took the focus away, and
   * a watched month is either the whole of a month frame or disjoint from it,
   * so two runs is the most a page can build. The case stays because
   * `frameDays` is a function of two dates rather than of a route: a rule that
   * held only for the inputs one caller happens to send today is a rule that
   * breaks the first time another caller sends something else, and this is the
   * one frame that has already caught it out.
   */
  const focusedWeek = frameDays(scatterWindow('2027-W09', 'week'), {
    from: '2027-03-06',
    to: '2027-03-06',
  });

  it('names each archive once, however many stretches it holds', () => {
    expect(sourceRuns(focusedWeek).map((run) => run.source)).toEqual(['curve', 'board', 'curve']);
    expect(railLabels(focusedWeek, TRACK).map((label) => label.source)).toEqual(['curve', 'board']);
  });

  it('draws no two labels through each other in that frame', () => {
    // Measured in a browser before the fix: the board label spanned 504.5 to
    // 700.8 and the third run's curve label 653.3 to 740.5 — 47.5 units of
    // overlap, which read as garbled text rather than as something broken.
    const labels = railLabels(focusedWeek, TRACK);
    expect(disjoint(labels)).toBe(true);
  });

  it('puts each label on the widest stretch its archive holds', () => {
    // The curve holds 1-5 March and 7 March; the label belongs on the five.
    const [curve, board] = railLabels(focusedWeek, TRACK);
    const unit = TRACK / 7;
    expect(curve.centre).toBeCloseTo(2.5 * unit, 6);
    expect(board.centre).toBeCloseTo(5.5 * unit, 6);
  });

  it('shortens the wording where the full form will not fit its own stretch', () => {
    const [curve, board] = railLabels(focusedWeek, TRACK);
    // One date of seven is 94 units and the full board wording needs 196.
    expect(board.text).toBe('flights, by hour');
    // Five dates is 471, and the curve's full wording needs 87.
    expect(curve.text).toBe('one price a date');
  });

  it('still names a stretch too narrow for even the short form', () => {
    // A whole month with the boards narrowed to one date: 21 units of track
    // against 87 of glyphs. The label overhangs and still points at the
    // stretch, because dropping the name of the one stretch a reader cannot
    // identify from its marks is the rail failing at its job.
    const month = frameDays(scatterWindow('2027-03', 'month'), {
      from: '2027-03-16',
      to: '2027-03-16',
    });
    const labels = railLabels(month, TRACK);
    expect(labels.map((label) => label.source).sort()).toEqual(['board', 'curve']);
    expect(labels.find((label) => label.source === 'board')!.text).toBe('flights, by hour');
    expect(disjoint(labels)).toBe(true);
  });

  it('names one archive where the frame only has one', () => {
    const inside = frameDays(scatterWindow('2027-W10', 'week'), MARCH);
    expect(railLabels(inside, TRACK)).toEqual([
      expect.objectContaining({ source: 'board', text: 'every flight, at the hour it departs' }),
    ]);
  });

  it('keeps every label inside the plot rather than hanging one off the edge', () => {
    const labels = railLabels(focusedWeek, TRACK);
    for (const label of labels) {
      expect(label.centre - label.width / 2).toBeGreaterThanOrEqual(0);
      expect(label.centre + label.width / 2).toBeLessThanOrEqual(TRACK);
    }
  });

  it('drops one only when the two cannot be fitted at any wording', () => {
    // A track far narrower than this chart's, which is the only way to force
    // it. The boards survive a tie because a bar reads as a whole-date price on
    // its own while a column of dots needs the clock named.
    const labels = railLabels(focusedWeek, 120);
    expect(labels).toHaveLength(1);
    expect(disjoint(labels)).toBe(true);
  });

  it('never crosses, for every frame a month-wide or single-date range can produce', () => {
    /*
     * The invariant stated as a sweep rather than as an argument from the
     * geometry, because the defect was exactly a case nobody had enumerated.
     * Every ISO week and every calendar month of 2027, against the whole month
     * and against each single date inside it — the second of which no watch
     * produces since 12.260, and which is swept anyway because the narrow
     * range is where the runs multiply and the labels collide.
     */
    const watches: { from: string; to: string }[] = [MARCH];
    for (let day = 1; day <= 31; day += 1) {
      const date = `2027-03-${String(day).padStart(2, '0')}`;
      watches.push({ from: date, to: date });
    }

    const keys: [string, 'week' | 'month'][] = [];
    for (let week = 8; week <= 14; week += 1) {
      keys.push([`2027-W${String(week).padStart(2, '0')}`, 'week']);
    }
    for (let month = 2; month <= 4; month += 1) {
      keys.push([`2027-${String(month).padStart(2, '0')}`, 'month']);
    }

    let checked = 0;
    for (const watch of watches) {
      for (const [key, granularity] of keys) {
        const labels = railLabels(frameDays(scatterWindow(key, granularity), watch), TRACK);
        expect(disjoint(labels)).toBe(true);
        // And every archive on screen is still named exactly once.
        expect(new Set(labels.map((label) => label.source)).size).toBe(labels.length);
        checked += 1;
      }
    }
    expect(checked).toBe(watches.length * keys.length);
  });
});
