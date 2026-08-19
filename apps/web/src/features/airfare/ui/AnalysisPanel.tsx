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
  type Granularity,
} from '@/features/airfare/lib/buckets';
import { leadAxis, leadBaseline, leadSnapshots } from '@/features/airfare/lib/leadTime';
import { FlightScatterChart } from '@/features/airfare/ui/FlightScatterChart';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';
import type { FarePricePoint, FareSnapshot } from '@/shared/api/fares';

import styles from './AnalysisPanel.module.css';

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/**
 * Three charts over one archive, and the reader picks which — 12.140, widened
 * by 12.170.
 *
 * They are drawn on three different kinds of time and none of them folds into
 * another. "Price history" is **observation** time: what the cheapest fare was
 * on each day we looked, which answers "is this fare rising or falling as we
 * watch it". "Lead time" is **days before departure**: the same fares placed
 * by how far ahead of the flight they were seen, which answers "how far ahead
 * should I buy". "Flights" is **departure** time: every itinerary in the
 * watched month, on the day and at the hour it leaves, which answers "which
 * departure do I book". One chart would have needed one x axis to mean three
 * things at once.
 */
type ChartView = 'history' | 'lead' | 'flights';

const VIEWS: { value: ChartView; label: string }[] = [
  { value: 'history', label: 'Price history' },
  { value: 'lead', label: 'Lead time' },
  { value: 'flights', label: 'Flights' },
];

/** Which clock the chart under the switches is drawn on, said in full. */
const WHAT: Record<ChartView, string> = {
  history: 'Across the days we looked — the x axis is when the price was observed.',
  lead: 'Across the run-up to departure — the x axis is whole days before the flight, not dates.',
  flights: 'Across the month being flown — the x axis is when each itinerary departs.',
};

type AnalysisPanelProps = {
  route: FareRoute | null;
  snapshots: FareSnapshot[];
  baseline: FarePricePoint[];
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
};

/**
 * The chart, its two switches, and the state that says which period is open.
 *
 * **The period lives here rather than inside the scatter — 12.170.** It used
 * to be state of `FlightScatterChart`, which is the component the chart switch
 * unmounts: a reader who walked to the ninth of thirty-one departures, looked
 * at the price history and came back found themselves on the first again,
 * because the state that remembered where they were had been thrown away with
 * the subtree that held it. Nothing about the scatter changed and nothing was
 * reset on purpose; the period simply had nowhere to live that outlived the
 * view. Here it outlives all three views, because this is the panel the switch
 * belongs to.
 *
 * The granularity is still the page's, because the flight table underneath
 * this panel is grouped by it too and the two must not disagree about what a
 * week is.
 */
export function AnalysisPanel({
  route,
  snapshots,
  baseline,
  granularity,
  onGranularityChange,
}: AnalysisPanelProps) {
  const [view, setView] = useState<ChartView>('history');
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
  const lead = useMemo(() => leadAxis(granularity), [granularity]);

  /*
   * Both axes' buckets, whichever view is open.
   *
   * Measured rather than assumed: the widest series on disk is the provider's
   * 1,914-row baseline, and gathering it twice is two passes over two thousand
   * numbers — under a millisecond, and only on a granularity change. Making it
   * conditional would put `view` in the dependencies of all four and recompute
   * the lot every time the reader flipped the chart, which is the more common
   * click of the two.
   */
  const ours = useMemo(() => bucketSnapshots(snapshots, granularity), [snapshots, granularity]);
  const theirs = useMemo(() => bucketBaseline(baseline, granularity), [baseline, granularity]);
  const leadOurs = useMemo(() => leadSnapshots(snapshots, granularity), [snapshots, granularity]);
  const leadTheirs = useMemo(() => leadBaseline(baseline, granularity), [baseline, granularity]);

  const where = route ? `${routeLabel(route)} departing in ${formatFlightMonth(route.month)}` : '';
  const currency = route?.currency ?? 'USD';

  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {route ? `${routeLabel(route)} · ${formatFlightMonth(route.month)}` : 'Price analysis'}
        </h2>
        {/*
          Two switches, in the order the questions come: which chart, then how
          wide a period. The granularity drives all three views and the table
          below, and since 12.170 flipping the chart no longer moves the period
          the reader was on either.
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
          <div className={styles.switch} role="group" aria-label="Group observations by">
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

      <p className={styles.what}>{WHAT[view]}</p>

      {/*
        Keyed by view, and the key is load-bearing rather than tidy.
        `PriceBandChart` draws two of the three views, so without a key React
        keeps one instance across the switch between them and the crosshair
        index goes with it — index 3 of the observation axis becoming index 3
        of the lead-time axis, which is a different period of a different kind.
        Found in a browser: the walk across the lead-time axis started four
        buckets in, at 281 days ahead rather than 284, because the reader's
        last position on the price history had come along. Before the third
        view existed the two branches were different component types and React
        remounted on its own.
      */}
      {view === 'history' ? (
        <PriceBandChart
          key="history"
          ours={ours}
          baseline={theirs}
          currency={currency}
          axis={calendar}
          label={route ? `Cheapest fare for ${where}, by ${granularity}` : 'Price analysis'}
        />
      ) : view === 'lead' ? (
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
      ) : (
        /*
          Keyed by route so the crosshair the reader left on a flight resets
          when they open a different watch. The period does not reset with it
          any more — it is held above this component and cleared by the route
          change itself.
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
      )}
    </>
  );
}
