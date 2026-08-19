import {
  summarise,
  type Bucket,
  type BucketAxis,
  type Granularity,
  type UnsoldPeriod,
} from '@/features/airfare/lib/buckets';
import { cheapestOffer, daysBeforeDeparture } from '@/features/airfare/lib/series';
import type { FarePricePoint, FareSnapshot } from '@/shared/api/fares';

/**
 * The same archive read the other way round: **how far ahead of departure** a
 * price was seen — 12.170, as 12.202 narrowed it.
 *
 * `buckets.ts` gathers observations by the calendar day we looked, and answers
 * "is this fare rising or falling as we watch it". `flightScatter.ts` places
 * flights by when they leave, and answers "which departure do I book". Neither
 * answers the question a traveller actually asks first, which is *when* to buy:
 * for that the x axis has to be days until departure, and the same fare seen
 * on 19 August for a 1 March flight and for a 31 March flight is two different
 * points rather than one.
 *
 * That last sentence is also the limit on where this is honest, and since
 * 12.204 the panel enforces it: for **one** departure date the lead is the
 * observation date subtracted from the flight date, so this is a relabelling
 * of the observation axis and the panel offers it as one. For a whole watched
 * month it is not — a single look lands on thirty-one leads at once, and the
 * curve through them is a curve across departure date wearing this axis's
 * labels. The functions here are unchanged and still take whatever they are
 * given; what changed is that the panel only asks for this reading where the
 * route names the one flight it is about.
 *
 * That question is only askable at all because the provider's own history
 * carries a departure beside every figure — 12.171. Our own snapshots have
 * carried one since the archive was laid out.
 *
 * Pure, and tested without a browser, like the rest of this feature's
 * arithmetic. Nothing here fetches or renders.
 */

/**
 * How many days of lead time one bucket covers, at each setting of the switch.
 *
 * The switch is the calendar one and its three words are kept, because the
 * reader is choosing a resolution rather than a unit and three resolutions is
 * what this page offers everywhere else. What they mean here is not calendar
 * at all — a week is seven days *until departure*, not Monday to Sunday, and a
 * month is thirty of them.
 *
 * Thirty rather than twenty-eight: "a month ahead" is the phrase a traveller
 * uses and it means about thirty days, where twenty-eight would be four weeks,
 * which is a different claim wearing the same word. The consequence is that
 * lead weeks do not nest inside lead months — and calendar weeks do not nest
 * inside calendar months either, for the same reason ISO weeks straddle a
 * month boundary, so the page is no less consistent than it was.
 */
export const LEAD_DAYS: Record<Granularity, number> = { day: 1, week: 7, month: 30 };

/** The `lead-0189` key form, zero-padded so a bucket start always sorts. */
const KEY = /^lead-(\d{4})$/;

/**
 * The bucket a lead time falls in, as a key.
 *
 * Padded to four digits because the key is compared as a string: the provider's
 * window reaches about 330 days and a route watched a year out reaches further,
 * and `lead-96` beside `lead-330` would sort the year-out bucket before the
 * three-month one. Opaque on purpose — what the reader sees is `leadLabel`,
 * and a key that tried to be both would have to choose between reading well
 * and sorting right.
 *
 * Null for a price seen on or after the day of departure. A negative lead time
 * is not a point on this axis: it means the collector reached a departure that
 * had already gone, which is a fact about the collector. `bucketSnapshots`
 * still has every one of those observations on the calendar axis, where they
 * belong.
 */
export function leadKey(daysAhead: number, granularity: Granularity): string | null {
  if (!Number.isFinite(daysAhead) || daysAhead < 0) return null;
  const width = LEAD_DAYS[granularity];
  return `lead-${String(Math.floor(daysAhead / width) * width).padStart(4, '0')}`;
}

/** The two ends of what a key covers, in days before departure, both inclusive. */
export function leadSpan(
  key: string,
  granularity: Granularity,
): { near: number; far: number } | null {
  const parts = KEY.exec(key);
  if (!parts) return null;
  const near = Number(parts[1]);
  return { near, far: near + LEAD_DAYS[granularity] - 1 };
}

/**
 * What the axis prints: `194d ahead`, `189–195d ahead`.
 *
 * Every label carries its unit, so that none of them can be read as a date —
 * which is the one thing that would make this chart a lie rather than a second
 * opinion. `194d` beside a page whose other charts are ticked `09/03` needs the
 * `d` and it needs the word after it.
 *
 * The whole bucket is named even where only part of it was observed, which is
 * 12.60's rule carried across: a bucket holding two lead days out of seven is
 * still the seven-day bucket, and captioning it by what happened to land in it
 * would state a narrower window than the one being counted.
 */
export function leadLabel(key: string, granularity: Granularity): string {
  const span = leadSpan(key, granularity);
  if (span === null) return key;
  return span.near === span.far ? `${span.near}d ahead` : `${span.near}–${span.far}d ahead`;
}

/** The same period in words, for the crosshair readout and the live region. */
export function leadPeriod(key: string, granularity: Granularity): string {
  const span = leadSpan(key, granularity);
  if (span === null) return key;
  return span.near === span.far
    ? `${span.near} days before departure`
    : `${span.near} to ${span.far} days before departure`;
}

/**
 * `lead day`, `lead week`, `lead month` — never a bare `day`.
 *
 * The readout says "one lead week at a time" where the observation-time chart
 * says "one week at a time", and the difference is the whole point: the reader
 * has to be able to tell from the sentence alone which of the two charts they
 * are being read.
 */
const UNIT: Record<Granularity, { one: string; many: string }> = {
  day: { one: 'lead day', many: 'lead days' },
  week: { one: 'lead week', many: 'lead weeks' },
  month: { one: 'lead month', many: 'lead months' },
};

/**
 * The lead-time axis, drawn furthest ahead on the left and departure day on
 * the right.
 *
 * Left to right is time running forwards on every other chart in this feature,
 * and it has to stay that way here or the reader would have to reverse one
 * chart in their head to compare it with the next. Running forwards towards a
 * departure means the *lead* counts down, so the keys are drawn in descending
 * order — which is what `BucketAxis.order` exists for.
 */
export function leadAxis(granularity: Granularity): BucketAxis {
  return {
    unit: UNIT[granularity],
    spell: (key) => leadPeriod(key, granularity),
    order: (a, b) => b.localeCompare(a),
    /*
     * Minus the near end, in days — 12.231.
     *
     * Negative because this axis is the one that counts down: left to right is
     * time running forwards on every chart in this feature, and running
     * forwards towards a departure means the lead shrinks. Negating it is what
     * makes "further right" mean "later" here as it does everywhere else, so
     * one scale serves both readings rather than one of them needing a flip.
     *
     * The far end rather than the near one, so a bucket sits at the edge its
     * own label starts counting from: `189–195d ahead` is drawn at 195 days
     * out, which is the left edge of the seven days it covers.
     */
    position: (key) => -(leadSpan(key, granularity)?.far ?? 0),
    baselineLegend:
      'What the provider charged at that lead time — one rounded figure per departure',
  };
}

function gather(entries: [string, number][], granularity: Granularity, axis: BucketAxis): Bucket[] {
  const groups = new Map<string, number[]>();
  for (const [key, price] of entries) {
    const prices = groups.get(key);
    if (prices) prices.push(price);
    else groups.set(key, [price]);
  }
  return [...groups.entries()]
    .map(([key, prices]) => summarise(key, leadLabel(key, granularity), prices))
    .sort((a, b) => axis.order(a.key, b.key));
}

/**
 * Our own observations, gathered by how far ahead of departure each was made.
 *
 * Every snapshot counts, not the latest board per departure: the point of this
 * axis is that the same departure priced on thirty consecutive days is thirty
 * points at thirty lead times, and keeping only the newest would collapse the
 * curve this view exists to draw down to one point per departure.
 *
 * The price per snapshot is its cheapest offer, exactly as `bucketSnapshots`
 * takes it — so the two charts are drawing the same measurement against two
 * different clocks, and a figure read off one can be compared with the other.
 */
export function leadSnapshots(snapshots: FareSnapshot[], granularity: Granularity): Bucket[] {
  const axis = leadAxis(granularity);
  const entries: [string, number][] = [];
  for (const snapshot of snapshots) {
    const offer = cheapestOffer(snapshot);
    if (!offer) continue;
    const days = daysBeforeDeparture(snapshot.capturedAt, snapshot.flightDate);
    const key = days === null ? null : leadKey(days, granularity);
    if (key !== null) entries.push([key, offer.price]);
  }
  return gather(entries, granularity, axis);
}

/**
 * The same empty boards `unsoldPeriods` counts, placed by lead time — 12.232.
 *
 * A board that came back with nothing on it still has a lead time, and the
 * reason for keeping it is the reason that function gives: dropping it makes a
 * run-up we asked about and found empty read exactly like a run-up nobody
 * reached. On this axis that matters more rather than less, because two thirds
 * of it is already stretches our own collector has never got to.
 */
export function leadUnsold(snapshots: FareSnapshot[], granularity: Granularity): UnsoldPeriod[] {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (cheapestOffer(snapshot)) continue;
    const days = daysBeforeDeparture(snapshot.capturedAt, snapshot.flightDate);
    const key = days === null ? null : leadKey(days, granularity);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: leadLabel(key, granularity), count }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

/**
 * The provider's own history, gathered the same way.
 *
 * Its own series and not merged into ours, for the reason `bucketBaseline`
 * states and which this axis does not weaken: it is one rounded integer with
 * no airline and no departure time, and drawing it on our line would quietly
 * change what the line measures. If anything the case is stronger here. On
 * this route the provider reaches 91 lead days and our own archive reaches 31
 * of them, all at the near end, so a merged line would be the provider's shape
 * for two thirds of its length and ours for the last third, with the join
 * reading as a movement in the fare rather than as a change of instrument.
 *
 * What the lead axis does change is how much the baseline is worth. On
 * observation time it is a second opinion about days we were also watching; on
 * this one it is 60 of the 91 buckets outright — the only evidence there is
 * about buying six months out, and it will stay that way until the collector
 * has run for six months.
 */
export function leadBaseline(points: FarePricePoint[], granularity: Granularity): Bucket[] {
  const axis = leadAxis(granularity);
  const entries: [string, number][] = [];
  for (const point of points) {
    const days = daysBeforeDeparture(point.date, point.flightDate);
    const key = days === null ? null : leadKey(days, granularity);
    if (key !== null) entries.push([key, point.price]);
  }
  return gather(entries, granularity, axis);
}
