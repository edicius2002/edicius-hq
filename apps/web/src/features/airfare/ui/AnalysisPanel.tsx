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
import {
  anchorFor,
  frameDays,
  frameSource,
  framePeriodKeys,
  type FrameSource,
} from '@/features/airfare/lib/departureFrame';
import {
  activeKey,
  departureDays,
  scatterWindow,
  stepKey,
  type WatchedRange,
} from '@/features/airfare/lib/flightScatter';
import { DepartureChart } from '@/features/airfare/ui/DepartureChart';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';
import type { CalendarCurve, FarePricePoint, FareSnapshot } from '@/shared/api/fares';

import styles from './AnalysisPanel.module.css';

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/**
 * **Two charts over one route, and one control each — 12.240, answering 12.201.**
 *
 * The panel reached four buttons, three x-axis units and two extra switches
 * before anybody added a fifth. 12.201 cut the four views to two; this cuts what
 * is left to two questions and no reader-operated modes at all:
 *
 * "How the price moved" is one route's own history on one axis — what the
 * cheapest fare was on each day we looked. It has no labelling control and no
 * granularity. The lead-time reading is withdrawn rather than hidden (12.241),
 * and the day is the only period this chart can be honestly drawn at (12.242).
 *
 * "What each date costs" is which departure to book, and the archive that
 * answers is chosen by the date rather than by a zoom (12.243). Inside the
 * watched month the boards answer, with every itinerary at its departure hour;
 * outside it the booking horizon does, one price a date. A period straddling
 * the boundary is answered by both in one frame.
 *
 * The two charts really are different questions on different units, so nothing
 * here puts two units beside each other: exactly one axis is on screen at a
 * time.
 */
type ChartView = 'moves' | 'days';

/** Chart A answers to one name, because it has one reading. */
const MOVES_NAME = 'How the price moved';

/**
 * Chart B's name follows what it is drawing — 12.246.
 *
 * Every name it can wear is rendered at once, stacked in one grid cell with the
 * live one visible, so the control is as wide as its widest name whichever is
 * showing. That is the whole mechanism for "the text changes and nothing
 * reflows": a `min-width` in pixels would be a guess that a font change breaks,
 * while the stack is the measurement itself. The order matters only for the
 * screen reader, which is given the live name alone.
 */
const DAYS_NAMES: Record<FrameSource, string> = {
  none: 'What each date costs',
  boards: 'Flights seen',
  curve: 'Cheapest per date',
  mixed: 'Flights and cheapest per date',
};

/** Which clock the chart under the switches is drawn on, said in full. */
const WHAT: Record<string, string> = {
  moves:
    'Across the days we looked — the x axis is when the price was observed, one point a day, whatever the period switch is set to.',
  'days/none':
    'Across the departure dates being watched — nothing has been collected for them yet.',
  'days/boards':
    'Across the month being flown — the x axis is a clock, and every itinerary sits at the hour it departs.',
  'days/curve':
    'Beyond the watched month — the x axis is departure dates, and each carries one cheapest fare for the whole date with no time of day.',
  'days/mixed':
    'Across the end of the watched month — itineraries at the hour they depart up to its last date, then one price a date beyond it. The rule in the chart is where the axis stops being a clock.',
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
 * The two charts, the switch between them, and the state that says which period
 * is open.
 *
 * **The period lives here rather than inside the chart — 12.170.** It used to
 * be state of the departure chart, which is the component the chart switch
 * unmounts: a reader who walked to the ninth of thirty-one departures, looked
 * at the price history and came back found themselves on the first again. Here
 * it outlives both charts.
 *
 * **And so does the navigation — 12.244.** Which periods there are to step to
 * is now a question about two archives rather than one: the boards decide what
 * a day view can reach, and the horizon decides how far a week or a month view
 * can walk. That belongs where the anchor already is, and it also lets the
 * switch above name the chart after the frame it is about to draw.
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
  const routeKey = route ? routeId(route) : null;

  /*
   * The departure day the chart is anchored on, and the route it means
   * something for.
   *
   * A day rather than an index into the periods — 12.143 — because the period
   * switch rebuilds the periods under it: an index kept across a week → day
   * flip points at the seventh day of the month instead of at the day being
   * read, where a day survives the flip.
   *
   * The route travels with it because an anchor is only a day of *one* watch.
   * The comparison is made during the render that notices, which is React's own
   * answer to a prop the state depends on — an effect would paint the stale
   * period first and then correct it.
   */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [anchorRoute, setAnchorRoute] = useState(routeKey);
  if (anchorRoute !== routeKey) {
    setAnchorRoute(routeKey);
    setAnchor(null);
  }
  const departureAnchor = anchorRoute === routeKey ? anchor : null;

  /*
   * Chart A is drawn by day and by nothing else — 12.242.
   *
   * The period switch used to move it, and what that bought was a chart of
   * eleven points: the owner's archive is 68 observations over a few weeks, and
   * a week bucket folds a run of daily figures into one band whose middle is a
   * median of medians. What this chart exists to show is that a fare moved, and
   * a day is the coarsest period that can still show it — the collector's own
   * cadence is finer, and the provider's baseline is one figure a day, so a day
   * is also the only period on which the two series mean the same thing.
   */
  const axis = useMemo(() => calendarAxis('day'), []);
  const ours = useMemo(() => bucketSnapshots(snapshots, 'day'), [snapshots]);
  const theirs = useMemo(() => bucketBaseline(baseline, 'day'), [baseline]);
  const oursUnsold = useMemo(() => unsoldPeriods(snapshots, 'day'), [snapshots]);

  /*
   * What the watch is on, as two departure dates — 12.235.
   *
   * The watched month, which since 12.260 is the whole of what a watch is: this
   * was `readingPrefix` and a `'day'` period where a route named one departure
   * inside its month. `periodBounds` rather than arithmetic here, because it is
   * this feature's single answer to "what does a key cover".
   *
   * It does not clip chart B's frame. It decides which dates inside that frame
   * the boards may answer for, which is the same fact put to the use it was
   * always really for — 12.243. That use is why the month mattering again
   * changes nothing here beyond the width of the range: a month of board dates
   * is what the boards were always collected for.
   */
  const watched: WatchedRange | null = useMemo(() => {
    if (!route) return null;
    const bounds = periodBounds(route.month, 'month');
    return { from: bounds.from.slice(0, 10), to: bounds.to.slice(0, 10) };
  }, [route]);

  /*
   * Chart B's navigation — 12.244.
   *
   * The board days are what a *day* view may reach, and they are inside the
   * watched month by construction, so the day view can never arrive at a date
   * whose only price is a single timeless number. A week or a month may walk
   * out to wherever the horizon reaches, and where there is no horizon on disk
   * there is simply nowhere outside the month to walk to — which is this
   * route's truth rather than a page of empty frames.
   */
  const boardDays = useMemo(() => departureDays(snapshots), [snapshots]);
  const keys = useMemo(
    () => framePeriodKeys(boardDays, curve, granularity),
    [boardDays, curve, granularity],
  );
  const periodKey = activeKey(keys, granularity, departureAnchor ?? boardDays[0] ?? null);

  /*
   * What the frame about to be drawn is made of, so the switch can name the
   * chart after it — 12.246. Cheap: the window is a `periodBounds` call and the
   * days are at most thirty-one strings compared against two.
   */
  const source: FrameSource = useMemo(
    () =>
      periodKey === null
        ? 'none'
        : frameSource(frameDays(scatterWindow(periodKey, granularity), watched)),
    [periodKey, granularity, watched],
  );

  const step = (direction: -1 | 1) => {
    if (periodKey === null) return;
    const target = stepKey(keys, periodKey, direction);
    if (target === null) return;
    setAnchor(anchorFor(target, granularity, boardDays));
  };

  /*
   * What these figures are *of*: the watched month — 12.260.
   *
   * It was `formatReading` and a preposition that moved with it, because a
   * watch could name one departure inside its month and the page narrowed onto
   * it. The page narrows on `route.month` now, and the history request asks for
   * the same string, so the head and the figures under it cannot name different
   * things.
   */
  const where = route ? `${routeLabel(route)} departing in ${formatFlightMonth(route.month)}` : '';
  const currency = route?.currency ?? 'USD';
  const what = view === 'moves' ? 'moves' : `days/${source}`;
  const daysName = DAYS_NAMES[source];

  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {route ? `${routeLabel(route)} · ${formatFlightMonth(route.month)}` : 'Price analysis'}
        </h2>
        {/*
          Two switches, in the order the questions come: which chart, then how
          much calendar one period covers. There is no third any more — the
          labelling control and the zoom that used to sit between them were both
          the reader being asked to answer something the page already knows.
        */}
        <div className={styles.switches}>
          <div className={styles.switch} role="group" aria-label="Chart">
            <button type="button" aria-pressed={view === 'moves'} onClick={() => setView('moves')}>
              {MOVES_NAME}
            </button>
            {/*
              Chart B's button holds every name it can wear at once. Only the
              live one is visible; the rest are `visibility: hidden` in the same
              grid cell, so the button is as wide as its widest name and the
              name can change without the switch beside it moving a pixel.
              `aria-hidden` on the understudies, or a screen reader would read
              four names for one control.
            */}
            <button
              type="button"
              aria-pressed={view === 'days'}
              aria-label={daysName}
              onClick={() => setView('days')}
              data-testid="days-chart-button"
            >
              <span className={styles.names}>
                {Object.entries(DAYS_NAMES).map(([kind, name]) => (
                  <span
                    key={kind}
                    className={kind === source ? styles.nameLive : styles.nameGhost}
                    aria-hidden={kind === source ? undefined : true}
                    {...(kind === source ? { 'data-testid': 'days-chart-name' } : {})}
                  >
                    {name}
                  </span>
                ))}
              </span>
            </button>
          </div>

          {/*
            "How much time one period covers", not "Group observations by" —
            12.205, and it now covers chart B and the flight table under this
            panel rather than chart A. It is never inert: the table below is
            grouped by it whichever chart is on screen, which is also why it
            stays put instead of vanishing with chart A — a control that
            disappeared on a chart switch would move the whole head.
          */}
          <div className={styles.switch} role="group" aria-label="How much time one period covers">
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

      {view === 'moves' ? (
        <PriceBandChart
          ours={ours}
          baseline={theirs}
          unsold={oursUnsold}
          currency={currency}
          axis={axis}
          label={route ? `Cheapest fare for ${where}, by day` : 'Price analysis'}
        />
      ) : (
        /*
          Keyed by route so the crosshair the reader left on a flight resets
          when they open a different watch. The period does not reset with it —
          it is held above this component and cleared by the route change.
        */
        <DepartureChart
          key={routeKey ?? 'none'}
          snapshots={snapshots}
          curve={curve}
          watched={watched}
          granularity={granularity}
          currency={currency}
          periodKey={periodKey}
          keys={keys}
          onStep={step}
          horizonLoading={curveLoading}
          horizonError={curveError}
          label={route ? `What each departure date costs for ${where}` : 'Fares by departure date'}
        />
      )}
    </>
  );
}
