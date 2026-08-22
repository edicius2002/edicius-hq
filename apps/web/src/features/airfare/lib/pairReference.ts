import { median } from '@/features/airfare/lib/series';
import type { FareSnapshot } from '@/shared/api/fares';
import { formatMoney } from '@/shared/lib/money';

/**
 * What this city pair usually costs, as one number the frames can be read
 * against.
 *
 * **The problem it exists for.** Every frame of chart B scales its price axis to
 * whatever that frame is drawing — `spanOfPrices` — so every month fills the
 * plot and two months at completely different prices look identical. Measured on
 * this archive: LIM-SCL's January frame runs $136.58 to $361.82 and its March
 * frame $158.79 to $714.64, and both are drawn edge to edge. Nothing on the
 * screen tells a reader which of them is the dear one.
 *
 * Sharing one domain across the pair was the alternative and it was measured and
 * rejected: it fixes the comparison by spending the resolution, taking the
 * median month from 85.7% of the plot to 4.6%. So the scale stays each frame's
 * own and one fixed figure is drawn across it instead. Above the line is dearer
 * than this pair usually is; below it is cheaper.
 *
 * Pure, and tested without a browser, for the reason `flightScatter.ts` and
 * `series.ts` are: the component decides how the line looks, never what it says.
 */

/* --------------------------------------------------------- what it is of -- */

export type PairReference = {
  /** The median of the cheapest fare per departure date, over the whole pair. */
  value: number;
  /** How many departure dates went into it. */
  dates: number;
  /**
   * `YYYY-MM-DD` — the day this figure was worked out on.
   *
   * **It is recomputed on every read, and it says so.** That is the whole of why
   * it carries a date at all. The archive behind it is days old and a handful of
   * passes deep, so a figure frozen today would freeze this week's noise into a
   * constant; freezing it is a one-line change — hand `pairReference` a literal
   * instead of today — once there are months of history to freeze. The cost of
   * leaving it moving is real and is stated where a reader can act on it: two
   * screenshots of this chart taken weeks apart are **not** comparable, because
   * the rule in them is not the same rule.
   *
   * Supplied by the caller rather than read off a clock in here, so the whole
   * module stays pure and the date the page prints elsewhere and the date this
   * figure claims cannot come from two different zones.
   */
  asOf: string;
};

/**
 * The median of the cheapest fare per departure date, over the whole city
 * pair's archive.
 *
 * Four choices are packed into that sentence and each was settled against this
 * archive rather than assumed.
 *
 * **Median, not mean.** The house rule, already written in `buckets.ts`: "one
 * collection during a fare glitch should not drag a whole week's middle with
 * it." EZE-SCL holds a real $1,788.78 offer and SCL-EZE a real $1,267.82 one;
 * a mean over either is a number nobody could act on.
 *
 * **The cheapest fare of each departure date, not every offer on its board.**
 * The question the line answers is "would I pay less than usual", which is about
 * the fare a reader would actually buy. Taking every offer folds business class
 * into the middle and moves it: $71.31 against $58.20 on AQP-LIM, $131.16
 * against $102.13 on SCL-EZE.
 *
 * **Cheapest ever seen for that date, not cheapest as last seen.** A departure
 * date is polled many times and the reference is a statement about the pair
 * rather than about the newest pass, so every look counts. On the two pairs
 * where it makes any difference at all it is 40 cents — SCL-AEP $84.46 against
 * $84.87 — and the version that keeps every look is the one that does not move
 * when a single pass is late.
 *
 * **The whole pair's archive, not the frame on screen.** A figure computed from
 * what is visible sits in the middle of what is visible and says nothing. This
 * is why the client is handed the whole pair by `GET /api/fares/history` — only
 * the baseline and the health counts are narrowed to a month — and why the
 * reference is assembled where that response lands rather than inside the chart,
 * which is handed one month.
 *
 * Keyed on `flightDate`, the departure the board was collected for, rather than
 * on each offer's own `departureAt`: a board is an answer about one date, and
 * an itinerary that leaves either side of midnight is still that date's answer.
 *
 * Null for an archive with nothing priced in it. A pair with no fares has no
 * typical fare, and drawing a line at zero would be the chart inventing the
 * cheapest flight ever found.
 */
export function pairReference(snapshots: FareSnapshot[], asOf: string): PairReference | null {
  const cheapest = new Map<string, number>();
  for (const snapshot of snapshots) {
    for (const offer of snapshot.offers) {
      const held = cheapest.get(snapshot.flightDate);
      if (held === undefined || offer.price < held) cheapest.set(snapshot.flightDate, offer.price);
    }
  }

  if (cheapest.size === 0) return null;
  return { value: median([...cheapest.values()]), dates: cheapest.size, asOf };
}

/** `2026-08-22` → `22/08`. The day and month alone: the year is not news. */
export function shortDay(day: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return parts === null ? day : `${parts[3]}/${parts[2]}`;
}

/** What the legend calls the line, with the date it was worked out on. */
export function referenceLegend(reference: PairReference): string {
  return `Pair median, ${shortDay(reference.asOf)}`;
}

/* ------------------------------------------------- where it lands, if at all -- */

/**
 * Where the figure falls against the frame it is drawn on.
 *
 * `below` means the reference is cheaper than everything in this frame, so every
 * fare on screen is dearer than the pair's usual — the line has run off the
 * bottom. `above` is the other way round and is the frame a reader wants to
 * find. This is not a corner case on real data: at day granularity 30 of
 * LIM-SCL's 62 departure dates and 4 of AEP-SCL's 31 put the reference outside
 * their own frame.
 */
export type ReferenceFall = 'inside' | 'below' | 'above';

export type PriceBand = { low: number; high: number };

/** The two heights a horizontal rule may be drawn between — the plot's own. */
export type Rails = { top: number; bottom: number };

export function referenceFall(value: number, span: PriceBand): ReferenceFall {
  if (value < span.low) return 'below';
  if (value > span.high) return 'above';
  return 'inside';
}

/**
 * The height to draw it at, clamped to the plot's own rails.
 *
 * **Clamped rather than omitted, and rather than stretching the domain to reach
 * it.** Stretching is the shared-scale answer in miniature — it would spend the
 * frame's resolution to hold a line that is not in it, which is the trade this
 * whole approach exists to refuse. Omitting loses the reading exactly where it
 * is most emphatic: a frame whose every fare is above the pair's usual is the
 * clearest "this month is dear" the chart can produce, and a line that vanished
 * there would leave the reader thinking nothing had been said.
 *
 * So the line goes to the rail and the drawing says it is against it — a mark
 * pointing off the plot, and a sentence in the accessible name. A rule flush
 * against the floor with an arrow under it reads as "off the scale, that way",
 * which is what it is.
 */
export function referenceY(value: number, span: PriceBand, rails: Rails): number {
  const usable = rails.bottom - rails.top;
  const width = span.high - span.low || 1;
  const y = rails.top + usable * (1 - (value - span.low) / width);
  return Math.min(Math.max(y, rails.top), rails.bottom);
}

/* ------------------------------------------------------- said out loud -- */

/**
 * The line as a sentence, for the reader who is not looking at the plot.
 *
 * It goes on the chart's accessible name rather than into a live region,
 * because it is not a thing that changes under a hand: it is a property of the
 * frame, like the dates the axis spans, and the accessible name is where this
 * chart already states those. A reader arriving at the plot hears what the frame
 * costs and what the pair usually costs in the same breath, which is the
 * comparison the ink is drawn for.
 *
 * How it was worked out is in the sentence and not only in a tooltip. A figure
 * a reader is invited to judge a month against has to say what it is a median
 * of, or it is a number with an authority nobody granted it.
 */
export function referenceSentence(
  reference: PairReference,
  fall: ReferenceFall,
  currency: string,
): string {
  const said =
    `This pair usually costs ${formatMoney(reference.value, currency)} — the median cheapest ` +
    `fare across ${reference.dates} departure date${reference.dates === 1 ? '' : 's'} of its ` +
    `archive, worked out on ${shortDay(reference.asOf)}.`;

  if (fall === 'below') {
    return `${said} Every fare in this frame is above it, so the line sits on the plot floor.`;
  }
  if (fall === 'above') {
    return `${said} Every fare in this frame is below it, so the line sits on the plot ceiling.`;
  }
  return said;
}
