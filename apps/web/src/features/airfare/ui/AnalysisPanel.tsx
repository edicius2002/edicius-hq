import { useMemo, useState } from 'react';

import {
  formatReading,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import {
  bucketBaseline,
  bucketSnapshots,
  calendarAxis,
  type Granularity,
} from '@/features/airfare/lib/buckets';
import { leadAxis, leadBaseline, leadSnapshots } from '@/features/airfare/lib/leadTime';
import { CalendarCurveChart } from '@/features/airfare/ui/CalendarCurveChart';
import { FlightScatterChart } from '@/features/airfare/ui/FlightScatterChart';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';
import type { CalendarCurve, FarePricePoint, FareSnapshot } from '@/shared/api/fares';

import styles from './AnalysisPanel.module.css';

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/**
 * **Two charts over one route, not four — 12.201, answering 12.197.**
 *
 * The switch used to offer Price history, Lead time, Flights and Departure
 * dates. Four buttons, three x-axis units, and 12.197 had already written down
 * that the last two were one axis at two scales and left them unmerged pending
 * a decision. This is that decision, and it takes the first two with it.
 *
 * "How the price moved" is one flight's own history. Observation time — what
 * the cheapest fare was on each day we looked — and lead time — the same fares
 * placed by how far ahead of the flight they were seen — are not two charts
 * for a single departure date D: lead is `D − observation date`, so the points
 * are the same points, reversed and shifted. They were two views because the
 * page had no way to say "the same chart, read the other way", and a reader
 * flipping between them was watching one series pretend to be two. Now it is
 * one chart with a labelling control, and both series — ours and the
 * provider's dashed baseline — stay on both readings.
 *
 * "What each day costs" is which departure to book, and it is one axis with a
 * zoom rather than two views. At the near end is the watched month with every
 * itinerary on it, at the hour it leaves; at the far end is the whole 331-day
 * booking horizon with one cheapest fare a day. Both are "which departure
 * date", which is why the zoom is a zoom and not a second question.
 *
 * The two charts that remain really are different questions on different
 * units, so nothing here puts two units beside each other: every control is a
 * toggle, and exactly one axis is on screen at a time.
 */
type ChartView = 'moves' | 'days';

const VIEWS: { value: ChartView; label: string }[] = [
  { value: 'moves', label: 'How the price moved' },
  { value: 'days', label: 'What each day costs' },
];

/**
 * Which way the reader is reading chart A's x axis — 12.202.
 *
 * Not two charts and not two datasets: `bucketSnapshots` and `leadSnapshots`
 * take the same cheapest offer out of the same snapshots, and for one
 * departure date the second is the first subtracted from the flight date. The
 * axis object is what differs, which is exactly what `BucketAxis` was built
 * for in 12.170 — this is that seam being used for what it is rather than for
 * a second button.
 */
type AxisReading = 'observed' | 'lead';

const AXIS_READINGS: { value: AxisReading; label: string }[] = [
  { value: 'observed', label: 'When we looked' },
  { value: 'lead', label: 'Days before departure' },
];

/** How far out chart B is standing — 12.203. Both ends are departure dates. */
type Zoom = 'month' | 'horizon';

const ZOOMS: { value: Zoom; label: string }[] = [
  { value: 'month', label: 'Watched month' },
  { value: 'horizon', label: 'Whole horizon' },
];

/** Which clock the chart under the switches is drawn on, said in full. */
const WHAT: Record<string, string> = {
  'moves/observed': 'Across the days we looked — the x axis is when the price was observed.',
  'moves/lead':
    'Across the run-up to departure — the x axis is whole days before the flight, not dates.',
  'days/month': 'Across the month being flown — the x axis is when each itinerary departs.',
  'days/horizon':
    'Across the whole booking horizon — the x axis is which departure date, every month out to where the provider stops answering.',
};

/**
 * Why the run-up reading is not on offer for a watch with no focus — 12.204.
 *
 * A month holds thirty-one departures, so one observation of it is thirty-one
 * different lead times at once and a curve drawn through them is a curve
 * across *departure date* wearing lead time's labels. The reader is told that
 * rather than left with a control that quietly does something else, and
 * nothing is lost: what those thirty-one points actually say is what chart B
 * draws, on the axis they belong to.
 */
const NO_LEAD =
  'Reading it as the run-up to a flight needs one departure date. This watch is a whole month, so one look at it lands on thirty-one different lead times at once — what each of those days costs is the other chart.';

type AnalysisPanelProps = {
  route: FareRoute | null;
  snapshots: FareSnapshot[];
  baseline: FarePricePoint[];
  /** The booking horizon as last collected, or null where there is none yet. */
  curve: CalendarCurve | null;
  /** True while that request is in flight, so "never collected" is not claimed early. */
  curveLoading: boolean;
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
};

/**
 * The two charts, the controls that pick between and inside them, and the
 * state that says which period is open.
 *
 * **The period lives here rather than inside the scatter — 12.170.** It used
 * to be state of `FlightScatterChart`, which is the component the chart switch
 * unmounts: a reader who walked to the ninth of thirty-one departures, looked
 * at the price history and came back found themselves on the first again,
 * because the state that remembered where they were had been thrown away with
 * the subtree that held it. Nothing about the scatter changed and nothing was
 * reset on purpose; the period simply had nowhere to live that outlived the
 * view. Here it outlives both charts and the zoom between them, because this
 * is the panel the switch belongs to.
 *
 * The granularity is still the page's, because the flight table underneath
 * this panel is grouped by it too and the two must not disagree about what a
 * week is.
 */
export function AnalysisPanel({
  route,
  snapshots,
  baseline,
  curve,
  curveLoading,
  granularity,
  onGranularityChange,
}: AnalysisPanelProps) {
  const [view, setView] = useState<ChartView>('moves');
  const [axisReading, setAxisReading] = useState<AxisReading>('observed');
  const [zoom, setZoom] = useState<Zoom>('month');
  const routeKey = route ? routeId(route) : null;

  /*
   * The departure day the scatter is anchored on, and the route it means
   * something for.
   *
   * A day rather than an index into the periods — 12.143 — because the
   * granularity switch rebuilds the periods under it: an index kept across a
   * week → day flip points at the seventh day of the month instead of at the
   * day being read, where a day survives the flip and `activeKey` derives
   * both the week containing it and the day itself.
   *
   * The route travels with it because an anchor is only a day of *one* watched
   * month. Opening another route clears it rather than letting `activeKey`
   * quietly fall back, which reads as the arrows having lost their place. The
   * comparison is made during the render that notices, which is React's own
   * answer to a prop the state depends on — the alternative, an effect, paints
   * the stale period first and then corrects it.
   */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [anchorRoute, setAnchorRoute] = useState(routeKey);
  if (anchorRoute !== routeKey) {
    setAnchorRoute(routeKey);
    setAnchor(null);
  }
  const departureAnchor = anchorRoute === routeKey ? anchor : null;

  /*
   * The reading actually in force, derived rather than corrected — 12.204.
   *
   * A reader who set the lead labelling on a focused watch and then opened one
   * with no focus must not be left on an axis that route cannot honestly draw.
   * Resolving it here means the stored preference survives the trip and comes
   * back when they open a focused watch again, where clearing the state would
   * throw away a choice they made about a different route.
   */
  const canReadLead = route?.focusDate !== undefined;
  const reading: AxisReading = canReadLead ? axisReading : 'observed';

  const calendar = useMemo(() => calendarAxis(granularity), [granularity]);
  const lead = useMemo(() => leadAxis(granularity), [granularity]);

  /*
   * Both readings' buckets, whichever one is in force.
   *
   * Measured rather than assumed: the widest series on disk is the provider's
   * 1,914-row baseline, and gathering it twice is two passes over two thousand
   * numbers — under a millisecond, and only on a granularity change. Making it
   * conditional would put `reading` in the dependencies of all four and
   * recompute the lot every time the reader flipped the labelling, which is
   * the more common click of the two.
   */
  const ours = useMemo(() => bucketSnapshots(snapshots, granularity), [snapshots, granularity]);
  const theirs = useMemo(() => bucketBaseline(baseline, granularity), [baseline, granularity]);
  const leadOurs = useMemo(() => leadSnapshots(snapshots, granularity), [snapshots, granularity]);
  const leadTheirs = useMemo(() => leadBaseline(baseline, granularity), [baseline, granularity]);

  /*
   * What these figures are *of*, in the words the reader picked them with —
   * 12.131.
   *
   * `formatReading` rather than `formatFlightMonth(route.month)`, and the
   * preposition moves with it. The month is what gets collected; the focus
   * date is what gets read, and by the time the snapshots reach this panel
   * they are already narrowed to it — `AirfarePage` filters on
   * `readingPrefix(route)` and the history request asks for the same string.
   * A head naming March over one day's figures is the page saying the wider
   * of the two things it knows while drawing the narrower, which is the one
   * arrangement worse than either alone.
   */
  const where = route
    ? `${routeLabel(route)} departing ${route.focusDate ? 'on' : 'in'} ${formatReading(route)}`
    : '';
  const currency = route?.currency ?? 'USD';
  const what = view === 'moves' ? `moves/${reading}` : `days/${zoom}`;

  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {route ? `${routeLabel(route)} · ${formatReading(route)}` : 'Price analysis'}
        </h2>
        {/*
          Three switches, in the order the questions come: which chart, how to
          read it, then how wide one point is. The middle one belongs to the
          chart above it and changes with it, which is why it is not a fourth
          fixed control — a "Zoom" sitting inert beside the price history would
          be the four-peer switch this change exists to undo.
        */}
        <div className={styles.switches}>
          <div className={styles.switch} role="group" aria-label="Chart">
            {VIEWS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={view === option.value}
                onClick={() => setView(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {view === 'moves' && canReadLead ? (
            <div className={styles.switch} role="group" aria-label="Read the axis as">
              {AXIS_READINGS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={reading === option.value}
                  onClick={() => setAxisReading(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          {view === 'days' ? (
            <div className={styles.switch} role="group" aria-label="Zoom">
              {ZOOMS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={zoom === option.value}
                  onClick={() => setZoom(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          {/*
            "How much time one point covers", not "Group observations by" —
            12.205. Day, Week and Month have not grouped observations alone
            since the lead axis landed, and under chart B they group
            *departures*: at the month zoom they decide how much of the month
            one screen holds, and at the horizon zoom how many departure dates
            fold into one point. A screen-reader user was being told this
            control did something it stopped doing two views ago.
          */}
          <div className={styles.switch} role="group" aria-label="How much time one point covers">
            {GRANULARITIES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={granularity === option.value}
                onClick={() => onGranularityChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className={styles.what}>
        {WHAT[what]}
        {view === 'moves' && !canReadLead ? <span className={styles.aside}> {NO_LEAD}</span> : null}
      </p>

      {/*
        Keyed by reading, and the key is load-bearing rather than tidy. Both
        readings are the same component, so without a key React keeps one
        instance across the flip and the crosshair index goes with it — index 3
        of the observation axis becoming index 3 of the lead-time axis, which
        is a different period of a different kind. Found in a browser: the walk
        across the lead-time axis started four buckets in, at 281 days ahead
        rather than 284, because the reader's last position on the price
        history had come along.
      */}
      {view === 'moves' ? (
        reading === 'observed' ? (
          <PriceBandChart
            key="observed"
            ours={ours}
            baseline={theirs}
            currency={currency}
            axis={calendar}
            label={route ? `Cheapest fare for ${where}, by ${granularity}` : 'Price analysis'}
          />
        ) : (
          <PriceBandChart
            key="lead"
            ours={leadOurs}
            baseline={leadTheirs}
            currency={currency}
            axis={lead}
            label={
              route
                ? `Cheapest fare for ${where}, by how many days before departure it was seen`
                : 'Fares by days before departure'
            }
          />
        )
      ) : zoom === 'month' ? (
        /*
          Keyed by route so the crosshair the reader left on a flight resets
          when they open a different watch. The period does not reset with it
          any more — it is held above this component and cleared by the route
          change itself.

          It draws whatever the page narrowed to, which for a focused watch is
          that one departure's board rather than the month's. That is the same
          narrowing every other figure on the page is under (12.131), and the
          whole month's shape is still a zoom away.
        */
        <FlightScatterChart
          key={routeKey ?? 'none'}
          snapshots={snapshots}
          granularity={granularity}
          currency={currency}
          anchor={departureAnchor}
          onAnchorChange={setAnchor}
          label={
            route ? `Every flight for ${where}, by departure time` : 'Flights by departure time'
          }
        />
      ) : (
        /*
          Keyed by route for the scatter's reason, and it takes no anchor at
          all: this end of the zoom draws the whole horizon in one frame, so
          there is no period to be on and nothing for the arrows to step to.
          Its own state is the crosshair and nothing else.
        */
        <CalendarCurveChart
          key={routeKey ?? 'none'}
          curve={curve}
          granularity={granularity}
          loading={curveLoading}
          label={
            route
              ? `Cheapest fare for ${routeLabel(route)} by departure date, across the whole booking horizon`
              : 'Fares by departure date'
          }
        />
      )}
    </>
  );
}
