import { useMemo, useState } from 'react';

import { useIsNarrow } from '@/app/layout/useIsNarrow';
import {
  formatFlightMonth,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import {
  bucketKey,
  bucketBaseline,
  bucketSnapshots,
  calendarAxis,
  periodBounds,
  unsoldPeriods,
  type Bucket,
  type Granularity,
  type UnsoldPeriod,
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
import type { PairReference } from '@/features/airfare/lib/pairReference';
import type { Viewport } from '@/features/airfare/lib/viewport';
import { DepartureChart } from '@/features/airfare/ui/DepartureChart';
import { PeriodSwitch } from '@/features/airfare/ui/PeriodSwitch';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';
import type { CalendarCurve, FarePricePoint, FareSnapshot } from '@/shared/api/fares';
import { Skeleton } from '@/shared/ui/Skeleton';

import styles from './AnalysisPanel.module.css';
import { FareHistoryStatus } from './FareHistoryStatus';

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
 * The two charts answer different questions on different units. A wide panel
 * puts their separately labelled axes beside each other; a phone keeps the
 * switch so each plot has the width it needs to be read and touched.
 */
type ChartView = 'moves' | 'days';

/** Chart A answers to one name, because it has one reading. */
const MOVES_NAME = 'How the price moved';

/**
 * Chart B's name follows what it is drawing — 12.246.
 *
 * On phones every name it can wear is rendered in the switch, stacked in one
 * grid cell with the live one visible. That keeps the switch's width stable as
 * the frame changes. On desktop its own chart heading follows the frame month.
 */
const DAYS_NAMES: Record<FrameSource, string> = {
  none: 'What each date costs',
  boards: 'Flights seen',
  curve: 'Cheapest per date',
  mixed: 'Flights and cheapest per date',
};

/** The departure controls take the same space before their frame can mount. */
function PendingFrameControls() {
  return (
    <div className={styles.pendingPager} aria-hidden="true" data-testid="analysis-pending-pager">
      <Skeleton width={26} height={26} radius={99} />
      <Skeleton width={32} height={12} />
      <Skeleton width={26} height={26} radius={99} />
      <Skeleton width={26} height={26} radius={99} />
    </div>
  );
}

/** The plot slot keeps its footprint while either archive is in flight. */
function PlotSkeleton({ label, kind }: { label: string; kind: ChartView }) {
  return (
    <div
      className={`${styles.plotSkeleton} ${kind === 'moves' ? styles.skeletonMoves : ''}`}
      role="status"
      data-testid="analysis-plot-skeleton"
    >
      <span className={styles.srOnly}>Loading {label}</span>
      <div className={styles.skeletonPriceAxis}>
        {[0, 1, 2, 3].map((tick) => (
          <Skeleton key={tick} width="75%" height={9} />
        ))}
      </div>
      <div className={styles.skeletonPlot}>
        {[0, 1, 2, 3].map((tick) => (
          <div key={tick} className={styles.skeletonGrid}>
            <Skeleton width="100%" height={1} />
          </div>
        ))}
        {kind === 'moves' ? (
          <div className={styles.skeletonLineArea}>
            <Skeleton className={styles.skeletonLine} width="100%" height="100%" radius={0} />
          </div>
        ) : (
          <div className={styles.skeletonBars}>
            {[43, 66, 53, 83, 58, 72, 48, 90, 62, 77].map((height, index) => (
              <Skeleton key={index} width="6%" height={`${height}%`} radius={3} />
            ))}
          </div>
        )}
      </div>
      <div className={styles.skeletonTimeAxis}>
        {[0, 1, 2, 3].map((tick) => (
          <Skeleton key={tick} width="13%" height={9} />
        ))}
      </div>
    </div>
  );
}

/**
 * Which archive is answering for the chart under the switch, in one short line.
 *
 * Each of these was two or three clauses restating the axis directly above the
 * axis, and the longest ran to three lines at the narrow end of this panel —
 * the single biggest block of prose on the page, and the one the owner quoted
 * first. The surviving line names the archive that answers for the frame,
 * because a mark's meaning depends on that source. The axis labels and seam
 * show how the horizontal scale changes inside a mixed frame.
 */

/**
 * The panel's id, so a control somewhere else can name what it moves.
 *
 * The month tabs in the watchlist row point `aria-controls` at this. Exported
 * the way `ADD_ROUTE_FORM_ID` is: the association between a control and the
 * thing it operates is stated rather than inferred from the tree, because in
 * both cases the two are nowhere near each other.
 *
 * **The panel, and not one chart inside it**, because a tab press moves both:
 * chart A's month, chart B's anchor, and the reading the detail strip prints.
 * If the anchor link is ever cut — leaving a tab that moves chart A alone —
 * this must narrow to chart A's own stage rather than go on claiming the panel.
 */
export const ANALYSIS_PANEL_ID = 'airfare-analysis';

type AnalysisPanelProps = {
  updatingMonth?: string | null;
  unavailableMonths?: readonly string[];
  historyLoading?: boolean;
  historyError?: Error | null;
  historyAvailable?: boolean;
  onHistoryRetry?: () => void;
  route: FareRoute | null;
  /**
   * Which of the route's months is being read.
   *
   * A prop rather than something taken off the route, because a watch holds
   * several months and this panel draws one. Everything here that narrows —
   * the watched range, the head, the figures — takes this same value, so the
   * heading and the frame cannot name different months of one watch.
   */
  month: string | null;
  /**
   * Every month this route is watched on — what chart B draws.
   *
   * A prop rather than `route.months`, even though `route` is right here and
   * carries them. The page is the one place that decides what this panel draws,
   * and the page is where `watchedSnapshots` below was narrowed; a panel that
   * read the months off the route while the page narrowed the archive from
   * somewhere else could put a board dot on a date the frame calls curve. One
   * value, one owner.
   */
  watchedMonths: readonly string[];
  /**
   * The archive for the reading month — chart A's, the flight table's and the
   * detail strip's.
   *
   * Named for its scope rather than left as `snapshots`, because the pair below
   * it differs by one word and confusing them is a silent wrong-scope bug: the
   * prefix says which chart at every use site.
   */
  monthSnapshots: FareSnapshot[];
  /** The archive for every watched month — chart B's. */
  watchedSnapshots: FareSnapshot[];
  baseline: FarePricePoint[];
  /** Persisted daily series when the historical archive has not been downloaded. */
  priceDays?: Bucket[];
  providerDays?: Bucket[];
  unsoldDays?: UnsoldPeriod[];
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
  /**
   * The departure day chart B is anchored on, and where a route change restores
   * it from — held per route by the page since the reading became a route's own.
   */
  anchor: string | null;
  onAnchorChange: (anchor: string | null) => void;
  /** How much of chart B's frame is on screen, or null for the whole of it. */
  viewport: Viewport | null;
  onViewportChange: (viewport: Viewport | null) => void;
  /**
   * The open route as a link out needs it, passed through to chart B and used
   * for nothing else here.
   *
   * `route` above already carries the city pair, and this is deliberately not
   * derived from it: the origin's *country* decides which storefront a carrier's
   * search opens in and is not on a `FareRoute` at all — it comes off the
   * airports table the page holds for the map. Assembled once above and handed
   * down whole, so the two panels that draw these links cannot disagree about
   * which leg they are drawing them for.
   */
  leg?: { origin: string; destination: string; originCountry: string | null } | null;
  /**
   * What this city pair usually costs, passed through to chart B and used for
   * nothing else here.
   *
   * Assembled above this component because it is the one figure on the page that
   * is **not** about the watched month: `snapshots` here has already been
   * narrowed to that month, and the whole point of the reference is that it
   * comes from the pair's entire archive. See `lib/pairReference.ts`.
   */
  reference?: PairReference | null;
};

/**
 * The two charts, their phone switch, and the state that says which period is open.
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
  updatingMonth = null,
  unavailableMonths,
  historyLoading = false,
  historyError = null,
  historyAvailable = true,
  onHistoryRetry,
  route,
  month,
  watchedMonths,
  monthSnapshots,
  watchedSnapshots,
  baseline,
  priceDays,
  providerDays,
  unsoldDays,
  curve,
  curveLoading,
  curveError = null,
  granularity,
  onGranularityChange,
  anchor,
  onAnchorChange,
  viewport,
  onViewportChange,
  leg = null,
  reference = null,
}: AnalysisPanelProps) {
  /*
   * The phone switch opens on chart B — `the-panel-opens-on-flights-seen`.
   *
   * It used to open on chart A because chart A was the older reading and the
   * one that needed no choosing. What changed is what a reader arrives to
   * answer: chart B draws the flights themselves against the departure dates
   * of the month they are watching, which is the question the watchlist row
   * beside it was pressed to ask. Chart A answers what the route has cost over
   * time, which is a second question and is one press away.
   *
   * On desktop both charts are visible and the switch state is only held for a
   * later phone layout, so resizing does not reset a choice made there.
   */
  const [view, setView] = useState<ChartView>('days');
  const narrow = useIsNarrow();
  /*
   * Where the departure chart draws its own head — the frame arrows and pin.
   *
   * State rather than a ref, because a portal needs its target to exist on the
   * render that reads it and a ref is still null on the first one. A callback
   * ref writing to state costs one extra render, once, on mount.
   */
  const [chartMeta, setChartMeta] = useState<HTMLDivElement | null>(null);
  const [frameMonth, setFrameMonth] = useState<string | null>(null);
  const routeKey = route ? routeId(route) : null;

  /*
   * The departure day the chart is anchored on comes from above now.
   *
   * It was state here, paired with the route it belonged to and cleared on
   * every change of route — the right answer while there was nothing to restore
   * it *to*. A route that remembers how it was last read does not need its
   * anchor cleared, it needs it looked up, so both the clearing and the
   * route-tracking state have gone to `useRouteView` and this component takes
   * the answer as a prop. It is still a *day* rather than an index into the
   * periods, for 12.143's reason: the period switch rebuilds the periods under
   * it, and an index kept across a week → day flip points at the seventh day of
   * the month instead of at the day being read.
   */
  const departureAnchor = anchor;

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
  // Chart A's three inputs, all of the reading month. It asks what one month's
  // price has done over time, so a second month's observations bucketed onto
  // the same dates would widen the band into "cheapest across both", which is
  // not a thing anybody was ever quoted.
  const computedOurs = useMemo(() => bucketSnapshots(monthSnapshots, 'day'), [monthSnapshots]);
  const computedTheirs = useMemo(() => bucketBaseline(baseline, 'day'), [baseline]);
  const computedUnsold = useMemo(() => unsoldPeriods(monthSnapshots, 'day'), [monthSnapshots]);
  const ours = priceDays ?? computedOurs;
  const theirs = providerDays ?? computedTheirs;
  const oursUnsold = unsoldDays ?? computedUnsold;

  /*
   * What the watch is on, as one range of departure dates per watched month.
   *
   * The watched months, which since `a-watch-is-a-pair-and-its-months` are the
   * whole of what a watch is — 12.235 for the shape: this
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
  const watched: WatchedRange[] = useMemo(
    () =>
      watchedMonths.map((watchedMonth) => {
        const bounds = periodBounds(watchedMonth, 'month');
        return { from: bounds.from.slice(0, 10), to: bounds.to.slice(0, 10) };
      }),
    [watchedMonths],
  );

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
  // Over every watched month, not the reading one. This is what lets the arrows
  // reach a second watched month at all: built from the narrowed archive, a
  // month whose snapshots the page had already thrown away could never be
  // offered as a period, so fixing `isWatched` alone would have left the frame
  // unable to walk to the boards it had just learned to draw.
  const boardDays = useMemo(() => departureDays(watchedSnapshots), [watchedSnapshots]);
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
  /* A disabled query can be isPending without a route to fetch. */
  const archivePending = route !== null && historyLoading;
  const horizonPending = route !== null && curveLoading;
  const departurePending = archivePending || horizonPending;
  /*
   * Before either archive yields a period, the selected month and anchor still
   * identify the frame whose source the header should name. Once the keys are
   * known, the actual frame keeps ownership of that decision.
   */
  const sourcePeriodKey =
    periodKey ??
    (departurePending && month ? bucketKey(departureAnchor ?? `${month}-01`, granularity) : null);
  const source: FrameSource = useMemo(
    () =>
      sourcePeriodKey === null
        ? 'none'
        : frameSource(frameDays(scatterWindow(sourcePeriodKey, granularity), watched)),
    [sourcePeriodKey, granularity, watched],
  );

  const step = (direction: -1 | 1) => {
    if (periodKey === null) return;
    const target = stepKey(keys, periodKey, direction);
    if (target === null) return;
    onAnchorChange(anchorFor(target, granularity, boardDays));
  };

  /*
   * What these figures are *of*: the watched month — 12.260.
   *
   * It was `formatReading` and a preposition that moved with it, because a
   * watch could name one departure inside its month and the page narrowed onto
   * it. A watch now holds several months and the page reads one of them; the
   * history request asks for that same string, so the head and the figures
   * under it cannot name different things.
   */
  // Chart A's, and only chart A's. It used to feed both labels, which was
  // accidentally right while both charts drew the same month and is wrong now.
  const whereMonth =
    route && month ? `${routeLabel(route)} departing in ${formatFlightMonth(month)}` : '';
  const currency = route?.currency ?? 'USD';
  const daysName = DAYS_NAMES[source];
  const departureTitleMonth = departurePending ? month : (frameMonth ?? month);
  // A wide heading names the selected reading; chart B has its own title and
  // frame controls. On a phone the heading still follows the visible chart.
  const titleMonth = narrow && view === 'days' ? departureTitleMonth : month;

  const priceChart = archivePending ? (
    <PlotSkeleton label="saved fare history" kind="moves" />
  ) : historyError && !historyAvailable ? null : (
    <PriceBandChart
      ours={ours}
      baseline={theirs}
      unsold={oursUnsold}
      currency={currency}
      axis={axis}
      label={route ? `Cheapest fare for ${whereMonth}, by day` : 'Price analysis'}
    />
  );
  const departureChart = departurePending ? (
    <PlotSkeleton label="departure prices" kind="days" />
  ) : historyError && !historyAvailable && curve === null ? null : (
    <DepartureChart
      unavailableMonths={unavailableMonths}
      key={routeKey ?? 'none'}
      snapshots={watchedSnapshots}
      curve={curve}
      watched={watched}
      granularity={granularity}
      currency={currency}
      periodKey={periodKey}
      keys={keys}
      onStep={step}
      onFrameMonthChange={setFrameMonth}
      metaSlot={chartMeta}
      viewport={viewport}
      onViewportChange={onViewportChange}
      horizonLoading={curveLoading}
      horizonError={curveError}
      leg={leg}
      reference={reference}
      label={
        route
          ? `What each departure date costs for ${routeLabel(route)}`
          : 'Fares by departure date'
      }
    />
  );

  const historyNotice =
    historyError || updatingMonth ? (
      <div className={styles.plotNotice}>
        <FareHistoryStatus error={historyError} onRetry={onHistoryRetry} />
        {updatingMonth && !historyError ? (
          <p role="status">Updating saved fares for {formatFlightMonth(updatingMonth)}…</p>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {/*
            The visible chart, not the watch that contains it. Price history is
            always the reading month, while departure costs reports its visible
            frame month here; the largest label must never name March over an
            April frame. One singular month says what is actually on screen.
          */}
          {route && titleMonth
            ? `${routeLabel(route)} · ${formatFlightMonth(titleMonth)}`
            : 'Price analysis'}
        </h2>
        {narrow && (
          <div className={styles.switches}>
            <div className={styles.switch} role="group" aria-label="Chart">
              <button
                type="button"
                aria-pressed={view === 'moves'}
                onClick={() => setView('moves')}
              >
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
                aria-expanded={view === 'days'}
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
          </div>
        )}
        {narrow && view === 'days' && (
          <div className={`${styles.chartMeta} ${styles.chartMetaEnter}`}>
            <PeriodSwitch granularity={granularity} onChange={onGranularityChange} />
            <div ref={setChartMeta} className={styles.chartReading}>
              {departurePending ? <PendingFrameControls /> : null}
            </div>
          </div>
        )}
      </div>

      {narrow ? (
        <div className={`${styles.body} ${view === 'moves' ? styles.movesBody : ''}`}>
          {view === 'moves' ? priceChart : departureChart}
          {historyNotice}
        </div>
      ) : (
        <div className={styles.columns}>
          <section className={styles.column} aria-labelledby="price-chart-title">
            <h3 id="price-chart-title" className={styles.chartTitle}>
              {MOVES_NAME}
            </h3>
            <div className={`${styles.body} ${styles.movesBody}`}>
              {priceChart}
              {historyNotice}
            </div>
          </section>
          <section className={styles.column} aria-labelledby="departure-chart-title">
            <div className={styles.columnHead}>
              <h3 id="departure-chart-title" className={styles.chartTitle}>
                {daysName}
                {departureTitleMonth && ` · ${formatFlightMonth(departureTitleMonth)}`}
              </h3>
              <div className={styles.chartMeta}>
                <PeriodSwitch granularity={granularity} onChange={onGranularityChange} />
                <div ref={setChartMeta} className={styles.chartReading}>
                  {departurePending ? <PendingFrameControls /> : null}
                </div>
              </div>
            </div>
            <div className={styles.body}>{departureChart}</div>
          </section>
        </div>
      )}
    </>
  );
}
