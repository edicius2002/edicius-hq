import { describe, expect, it } from 'vitest';

import {
  anchorFor,
  curveMarks,
  frameDays,
  framePeriodKeys,
  frameSource,
  isWatched,
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

  it('draws both seams around a watch narrowed to one departure date', () => {
    // A focused watch reads one day, so a week holding it has curve dates on
    // each side. Reporting only the first would draw half the boundary.
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
