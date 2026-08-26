import {
  formatFlightDate,
  formatFlightMonth,
  lastCollectableDay,
  lastCollectableMonth,
  monthHasDeparted,
  monthOf,
  MONTH_NAMES,
} from '@/features/airfare/data/fareRoutes';

/**
 * The twelve cells of the month strip, as the editor draws them.
 *
 * A rule rather than markup, in its own module for the reason the rest of
 * `lib/` exists: which chips are offered, which are refused and why is a set of
 * decisions, and a test that has to render a form to read one of them is
 * testing the form.
 *
 * **The strip is one year at a time and the selection is not.** The booking
 * horizon reaches into a second calendar year for most of the year, so twelve
 * chips cannot hold every month a reader may watch. The year control beside the
 * strip chooses which twelve are drawn; `monthsElsewhere` is what stops the
 * months in the other year from being invisible.
 */

export type ChipRefusal = 'gone' | 'beyond-horizon';

export type MonthChip = {
  /** `YYYY-MM`. */
  month: string;
  /** What the cell prints: `Jan`. */
  short: string;
  /** The accessible name: `January 2027`. It carries the year, the cell cannot. */
  label: string;
  selected: boolean;
  /** Why this month cannot be picked, or null if it can. */
  refusal: ChipRefusal | null;
};

/** What a refused chip says on hover. The wording is the add form's own, kept. */
export function refusalText(refusal: ChipRefusal, today: string): string {
  return refusal === 'gone'
    ? 'That month has gone.'
    : `Fares are only on sale as far ahead as ${formatFlightDate(lastCollectableDay(today))}.`;
}

/** What a watched month that has since departed says on hover. */
export function staleText(month: string): string {
  return `${formatFlightMonth(month)} has gone; nothing more will be collected for it.`;
}

/**
 * The strip for one year.
 *
 * Twelve cells always, in calendar order, whatever the horizon reaches — a
 * strip that grew and shrank as the year control moved would be a control
 * changing shape under the reader, and a refused month that is *drawn* and says
 * why is the thing the two dropdowns could not do.
 *
 * **Disabling here does not contradict 12.264.** That decision refused to
 * narrow the month dropdown against the year dropdown, because "picking August
 * and then switching the year from 26 to 27 would have to un-pick the month" —
 * a control editing the reader's choice behind them. That hazard cannot arise
 * with chips: each one names a whole `YYYY-MM`, moving the year draws twelve
 * *different* cells, and no cell's value changes. Selecting August 2026 and
 * then moving to 27 leaves August 2026 selected and draws a different, refused
 * August 2027 beside it. Disabling is a statement about a month rather than a
 * change to a choice. The submit-time refusals stay regardless, because a
 * `disabled` attribute is an affordance and not a guarantee — the year rolls at
 * midnight whatever the strip last drew.
 *
 * **A selected month is never refused**, even once it has gone. A watch made in
 * August needs August to be removable in September, and a pressed control that
 * is also disabled is a trap with no way out of it.
 */
export function monthChips(year: string, selected: readonly string[], today: string): MonthChip[] {
  const thisMonth = monthOf(today);
  const lastMonth = lastCollectableMonth(today);

  return MONTH_NAMES.map((name, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    const isSelected = selected.includes(month);
    const refusal: ChipRefusal | null =
      month < thisMonth ? 'gone' : month > lastMonth ? 'beyond-horizon' : null;
    return {
      month,
      // Sliced rather than held in a second array, for the reason `MONTH_NAMES`
      // is one list: two would be two chances to spell a month differently
      // between the control that picks it and the row that prints it.
      short: name.slice(0, 3),
      label: `${name} ${year}`,
      selected: isSelected,
      refusal: isSelected ? null : refusal,
    };
  });
}

/**
 * The months of this selection that the strip on screen is not showing.
 *
 * `1 more in 27`, or null when the strip holds all of them. It exists because
 * the strip is per year and the watch is not: without it, a reader on 26 who
 * has picked March 2027 sees twelve unpressed chips and a form that looks
 * empty. Grouped by year and joined, though the horizon spans at most two so in
 * practice there is one clause.
 */
export function monthsElsewhere(selected: readonly string[], year: string): string | null {
  const counts = new Map<string, number>();
  for (const month of selected) {
    const other = month.slice(0, 4);
    if (other === year) continue;
    counts.set(other, (counts.get(other) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([other, count]) => `${count} more in ${other.slice(2)}`)
    .join(', ');
}

/**
 * How many month tabs a watchlist row puts on one line.
 *
 * Four, and it is measured rather than chosen. The row has 135.08px between the
 * city pair and the collect control at the panel's floor, and four tabs at
 * three letters each are 136.04 — so four is the most that fits and it fits by
 * nothing. The number lives in `RouteList.module.css` as the grid's track
 * count; this constant is here so the arithmetic in `routesScroll.test` and the
 * stylesheet cannot drift apart.
 */
export const MONTHS_PER_ROW = 4;

/**
 * What one tab prints: `Nov`.
 *
 * **Three letters, and never the year**, which is a real trade-off rather than
 * an oversight. `Nov 26` is 55.52px against `Nov`'s 31.76, so four tabs
 * carrying years would want 231px of a row that has 135 — 26.8rem of column
 * against a 23rem ceiling. Showing every month explicitly and showing the year
 * on each one are not both available at this width, and the owner asked for the
 * first.
 *
 * What carries the year instead: every tab's own accessible name
 * (`November 2026`), the `title` on the group listing all of them in full, and
 * the strip in the editor above, which is per-year by construction. A watch
 * spanning two Novembers is the case that reads ambiguously here, and it reads
 * unambiguously one press away.
 */
export function shortMonth(month: string): string {
  return MONTH_NAMES[Number(month.slice(5, 7)) - 1]?.slice(0, 3) ?? month;
}

/** Whether every month of a selection has been and gone. */
export function allDeparted(selected: readonly string[], today: string): boolean {
  return selected.length > 0 && selected.every((month) => monthHasDeparted(month, today));
}

/**
 * The months of a selection the horizon cannot reach, in order.
 *
 * Named rather than counted, because the refusal names them: telling a reader
 * that "some" of their months are past the horizon leaves them to work out
 * which, in a strip where the offending chips are the ones they just pressed.
 */
export function beyondHorizon(selected: readonly string[], today: string): string[] {
  const lastMonth = lastCollectableMonth(today);
  return selected.filter((month) => month > lastMonth);
}
