import { useMemo, useState } from 'react';

import {
  formatFlightMonth,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import {
  bucketBaseline,
  bucketSnapshots,
  calendarAxis,
  periodBounds,
  unsoldPeriods,
  type Granularity,
} from '@/features/airfare/lib/buckets';
import type { WatchedRange } from '@/features/airfare/lib/flightScatter';
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

/*
 * **The run-up reading is withdrawn, because nothing names a departure for it
 * to run up to** — 12.267.
 *
 * 12.202 made observation time and lead time one chart with a labelling
 * control, and 12.204 offered the lead labelling **only where the route named
 * one departure date**: a month holds thirty-one of them, so one observation
 * of a month lands on thirty-one lead times at once and a curve through them
 * is a curve across departure date wearing lead time's labels.
 *
 * The focus was the only thing that ever named that one departure, and 12.260
 * took it away. So the gate 12.204 wrote is now false for every watch there
 * can be, and a switch that can never appear beside a chart that can never
 * render is the unreachable branch this repository does not leave lying about.
 * It is removed rather than gated on a constant.
 *
 * `lib/leadTime.ts` is deliberately **kept**, with its own tests. Nothing in
 * it is unreachable — it is a pure mapping from snapshots to lead buckets, and
 * it is correct — and 12.204's reasoning is untouched: the day this page can
 * point at one departure again, the reading comes back from the library that
 * already computes it rather than from a rewrite.
 */

/** How far out chart B is standing — 12.203. Both ends are departure dates. */
type Zoom = 'month' | 'horizon';

const ZOOMS: { value: Zoom; label: string }[] = [
  { value: 'month', label: 'Watched month' },
  { value: 'horizon', label: 'Whole horizon' },
];

/** Which clock the chart under the switches is drawn on, said in full. */
const WHAT: Record<string, string> = {
  moves: 'Across the days we looked — the x axis is when the price was observed.',
  'days/month': 'Across the month being flown — the x axis is when each itinerary departs.',
  'days/horizon':
    'Across the whole booking horizon — the x axis is which departure date, every month out to where the provider stops answering.',
};

type AnalysisPanelProps = {
  route: FareRoute | null;
  snapshots: FareSnapshot[];
  baseline: FarePricePoint[];
  /** The booking horizon as last collected, or null where there is none yet. */
  curve: CalendarCurve | null;
  /** True while that request is in flight, so "never collected" is not claimed early. */
  curveLoading: boolean;
  /**
   * Why that request failed, where it did — 12.237. Null on success and while
   * it is still in flight; a chart handed one says so rather than reporting a
   * fault at our end as a fact about the route.
   */
  curveError?: Error | null;
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
  curveError = null,
  granularity,
  onGranularityChange,
}: AnalysisPanelProps) {
  const [view, setView] = useState<ChartView>('moves');
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

  const calendar = useMemo(() => calendarAxis(granularity), [granularity]);

  // One reading's buckets, where there used to be two gathered side by side
  // whichever was in force — 12.267. The lead pair went with the reading.
  const ours = useMemo(() => bucketSnapshots(snapshots, granularity), [snapshots, granularity]);
  const theirs = useMemo(() => bucketBaseline(baseline, granularity), [baseline, granularity]);
  // The boards that came back with nothing on them — 12.232.
  const oursUnsold = useMemo(() => unsoldPeriods(snapshots, granularity), [snapshots, granularity]);

  /*
   * What the watch is on, as two departure dates — 12.235.
   *
   * The watched month, which since 12.260 is the only thing a watch is. It was
   * `readingPrefix` here, clipping to the one focused day where there was one.
   * `periodBounds` rather than arithmetic, because it is this feature's single
   * answer to "what does a key cover" and a second one would let the frame and
   * the caption disagree.
   */
  const watched: WatchedRange | null = useMemo(() => {
    if (!route) return null;
    const bounds = periodBounds(route.month, 'month');
    return { from: bounds.from.slice(0, 10), to: bounds.to.slice(0, 10) };
  }, [route]);

  /*
   * What these figures are *of*: the watched month — 12.260.
   *
   * The page narrows the snapshots to the same `route.month` before they get
   * here, and the history request asks for the same string, so the head and
   * the figures under it cannot name different things.
   */
  const where = route ? `${routeLabel(route)} departing in ${formatFlightMonth(route.month)}` : '';
  const currency = route?.currency ?? 'USD';
  const what = view === 'moves' ? 'moves' : `days/${zoom}`;

  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {route ? `${routeLabel(route)} · ${formatFlightMonth(route.month)}` : 'Price analysis'}
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

          {/*
            "Read the axis as" stood here, between the chart switch and the
            zoom. It offered the run-up reading and could only offer it to a
            watch that named one departure date — 12.204 — which nothing does
            any more (12.267). Two switches where there were three, and chart A
            has one axis rather than one of two.
          */}

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

      <p className={styles.what}>{WHAT[what]}</p>

      {/*
        The `key="observed"` this chart carried was load-bearing while there
        were two readings sharing one component: without it React kept one
        instance across the flip and the crosshair index came along, so index 3
        of the observation axis became index 3 of the lead-time axis — a
        different period of a different kind. There is one reading now
        (12.267), so there is nothing to flip between and nothing to key apart.
      */}
      {view === 'moves' ? (
        <PriceBandChart
          ours={ours}
          baseline={theirs}
          unsold={oursUnsold}
          currency={currency}
          axis={calendar}
          label={route ? `Cheapest fare for ${where}, by ${granularity}` : 'Price analysis'}
        />
      ) : zoom === 'month' ? (
        /*
          Keyed by route so the crosshair the reader left on a flight resets
          when they open a different watch. The period does not reset with it
          any more — it is held above this component and cleared by the route
          change itself.

          It draws whatever the page narrowed to, which is the watched month
          and every departure in it — the same narrowing every other figure on
          the page is under, and the whole horizon is still a zoom away.
        */
        <FlightScatterChart
          key={routeKey ?? 'none'}
          snapshots={snapshots}
          granularity={granularity}
          currency={currency}
          anchor={departureAnchor}
          onAnchorChange={setAnchor}
          watched={watched}
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
          error={curveError}
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
