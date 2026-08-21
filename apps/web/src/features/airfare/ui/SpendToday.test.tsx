import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SpendToday } from '@/features/airfare/ui/SpendToday';
import type { FareSpend } from '@/shared/api/fares';

/**
 * The header strip that says what this address has already sent today.
 *
 * Most of this suite is about the three states nobody looks at until they
 * happen — a day with nothing on it, our own API not answering, and a ledger
 * that cannot be read — because those are the states a scheduled collector will
 * actually be in when something has gone wrong, and each of them has a wrong
 * answer that looks perfectly healthy.
 *
 * The rest is about the one thing the picture must not claim. 600 is a
 * judgement — the API's own configuration says the real limit is unknown and
 * deliberately unprobed — so there is no percentage anywhere on this strip, the
 * fill never changes colour, and the measured number sits on the track beside
 * the chosen one with a sentence saying which is which.
 */

const SPEND: FareSpend = {
  day: '2026-08-21',
  resetsAt: '2026-08-22T00:00:00+00:00',
  spent: 150,
  ceiling: 600,
  remaining: 450,
  busiestOnRecord: 329,
  kinds: [
    { kind: 'board', requests: 141 },
    { kind: 'calendar', requests: 9 },
  ],
};

function fill(): HTMLElement {
  const track = screen.getByTestId('spend-track');
  const bar = track.firstElementChild;
  if (!(bar instanceof HTMLElement)) throw new Error('the track has no fill in it');
  return bar;
}

describe('SpendToday', () => {
  it('says how much of today is spent, out of what, and on what', () => {
    render(<SpendToday spend={SPEND} loading={false} />);

    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('of 600')).toBeInTheDocument();
    expect(screen.getByText(/450 left/)).toBeInTheDocument();
    expect(screen.getByText(/141 boards · 9 calendars/)).toBeInTheDocument();
    // The instant is put into the reader's own clock, so what is pinned is that
    // the day's turnover is reported at all — the hour is the machine's.
    expect(screen.getByText(/resets \d/)).toBeInTheDocument();
    expect(fill()).toHaveStyle({ width: '25%' });
  });

  it('draws no percentage and no threshold, and marks the busiest real day', () => {
    const { container } = render(<SpendToday spend={SPEND} loading={false} />);

    // A percentage would be a claim about a safe maximum, and nobody knows 600
    // is one. The strip counts requests and nothing else.
    expect(container.textContent).not.toContain('%');
    expect(screen.getByTestId('spend-busiest')).toHaveStyle({ left: `${(329 / 600) * 100}%` });
    // And the sentence says which of the two numbers was measured.
    expect(
      screen.getByText(
        '329 is the busiest day on record; 600 is a ceiling we chose, not a limit anyone has measured.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a day with nothing on it as nothing rather than as a gap', () => {
    // A first run with no file yet and a day whose file is empty arrive here as
    // the same document — the server answers zero for both on purpose, because
    // a day nobody has collected on *is* a file that does not exist yet.
    render(
      <SpendToday spend={{ ...SPEND, spent: 0, remaining: 600, kinds: [] }} loading={false} />,
    );

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText(/Nothing sent yet today/)).toBeInTheDocument();
    // Not "600 left" as well, which is the same sentence twice.
    expect(screen.queryByText(/600 left/)).not.toBeInTheDocument();
    expect(fill()).toHaveStyle({ width: '0%' });
  });

  it('reports a ledger that cannot be read as a stopped collector, with no bar', () => {
    render(
      <SpendToday spend={{ ...SPEND, spent: null, remaining: 0, kinds: [] }} loading={false} />,
    );

    expect(screen.getByText('unknown')).toBeInTheDocument();
    const line = screen.getByText(/cannot be read, so every pass refuses until it can/);
    expect(line.className).toContain('refused');
    // No track at all. The only two lengths a bar could take here are none and
    // all, and both are claims the words are explicitly declining to make —
    // rendering it at zero would draw a stopped collector as a quiet morning.
    expect(screen.queryByTestId('spend-track')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('tells our own API not answering apart from the ledger not opening', () => {
    render(<SpendToday spend={undefined} loading={false} />);

    expect(screen.getByText('Today’s spend is unavailable.')).toBeInTheDocument();
    // Nothing is known about the collector in this branch, whereas above the
    // collector is known to have stopped. A shared wording would merge them.
    expect(screen.queryByText(/every pass refuses/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('spend-track')).not.toBeInTheDocument();
  });

  it('draws nothing at all before it has read anything', () => {
    // 12.234: nothing rather than a fallback. A placeholder figure here is a
    // claim about the collector made at the one moment nothing is known.
    const { container } = render(<SpendToday spend={undefined} loading={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps drawing the last reading while the next one is in flight', () => {
    // `isPending` is only true before the first answer; a refetch every minute
    // must not blank the strip it is refreshing.
    render(<SpendToday spend={SPEND} loading={true} />);
    expect(screen.getByText('150')).toBeInTheDocument();
  });

  it('stops the bar at the end of a ceiling the day has already overrun', () => {
    render(<SpendToday spend={{ ...SPEND, spent: 900, remaining: 0 }} loading={false} />);

    expect(screen.getByText('900')).toBeInTheDocument();
    expect(screen.getByText(/0 left/)).toBeInTheDocument();
    expect(fill()).toHaveStyle({ width: '100%' });
  });

  it('drops the high-water mark when the ceiling is below it', () => {
    // `FARES_DAILY_REQUEST_BUDGET` can be set under 329. A mark pinned to the
    // last pixel of the track would read as the ceiling rather than as the
    // separate, measured fact it is.
    render(
      <SpendToday spend={{ ...SPEND, spent: 20, ceiling: 200, remaining: 180 }} loading={false} />,
    );

    expect(screen.getByTestId('spend-track')).toBeInTheDocument();
    expect(screen.queryByTestId('spend-busiest')).not.toBeInTheDocument();
  });
});
