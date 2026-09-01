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
import type { PairReference } from '@/features/airfare/lib/pairReference';
import type { Viewport } from '@/features/airfare/lib/viewport';
import { DepartureChart } from '@/features/airfare/ui/DepartureChart';
import { PeriodSwitch } from '@/features/airfare/ui/PeriodSwitch';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';
import type { CalendarCurve, FarePricePoint, FareSnapshot } from '@/shared/api/fares';

import styles from './AnalysisPanel.module.css';

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

/**
 * Which archive is answering for the chart under the switch, in one short line.
 *
 * Each of these was two or three clauses restating the axis directly above the
 * axis, and the longest ran to three lines at the narrow end of this panel —
 * the single biggest block of prose on the page, and the one the owner quoted
 * first. What a reader cannot get from looking is which of two archives is
 * answering and therefore what one mark means, so that is what survives; how
 * the x axis works is the axis's own business and it is drawn, labelled and
 * railed below.
 *
 * **Which is also why none of them says "at the hour it departs" any more.**
 * Shortened to one clause, `days/boards` came out as `Every itinerary, at the
 * hour it departs.` — and the source rail under the same plot already reads
 * `every flight, at the hour it departs`, per stretch of the frame and with
 * more precision than a line above the chart can have. Two near-identical
 * sentences a few rows apart are worse than the long one they replaced, because
 * a reader now has to work out whether they are being told two things. So these
 * name the archive in the words the panel uses for it elsewhere — the boards,
 * the booking horizon — and leave the hour to the rail that is drawn on it.
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
  month,
  watchedMonths,
  monthSnapshots,
  watchedSnapshots,
  baseline,
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
   * The panel opens on chart B — `the-panel-opens-on-flights-seen`.
   *
   * It used to open on chart A because chart A was the older reading and the
   * one that needed no choosing. What changed is what a reader arrives to
   * answer: chart B draws the flights themselves against the departure dates
   * of the month they are watching, which is the question the watchlist row
   * beside it was pressed to ask. Chart A answers what the route has cost over
   * time, which is a second question and is one press away.
   *
   * The period switch unfolds from chart B's button (`period-switch-follows-
   * its-chart`), so opening here also means the switch is on screen from the
   * first paint rather than after a press. That is the visible cost and it is
   * wanted: `a-watch-opens-on-its-own-month` seeds the month, and a reader who
   * cannot see the control cannot tell the month was chosen for them.
   */
  const [view, setView] = useState<ChartView>('days');
  /*
   * Where the departure chart draws its own head — the flight count, the frame
   * arrows and the zoom reset.
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
  const ours = useMemo(() => bucketSnapshots(monthSnapshots, 'day'), [monthSnapshots]);
  const theirs = useMemo(() => bucketBaseline(baseline, 'day'), [baseline]);
  const oursUnsold = useMemo(() => unsoldPeriods(monthSnapshots, 'day'), [monthSnapshots]);

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
  const titleMonth = view === 'moves' ? month : (frameMonth ?? month);

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
            {/*
            The period control unfolds sideways out of the date-cost button and
            folds back into it on price history, rather than appearing and
            vanishing where it stands.

            It stays mounted through both states, which is the whole reason the
            fold can be seen at all: a control that unmounts has no width to
            animate from. `inert` and `aria-hidden` together keep a folded control out
            of the tab order and off a screen reader while it is still in the
            tree. Together and not either alone: `inert` is not carried
            everywhere yet, and hiding a focusable control from a screen reader
            while leaving it tabbable is the trap `aria-hidden` on its own sets — the
            visual fold alone would leave three buttons reachable inside a strip
            nobody can see.

            It still preserves the table grouping across a fold; the reading is
            kept, not the control's visibility.
          */}
            <div
              className={`${styles.periodFold} ${view === 'days' ? styles.periodOpen : ''}`}
              inert={view === 'days' ? undefined : true}
              aria-hidden={view === 'days' ? undefined : true}
            >
              <PeriodSwitch granularity={granularity} onChange={onGranularityChange} />
            </div>
          </div>
        </div>
        {/*
          The departure chart's own head, moved onto this row.

          A slot rather than markup: the count is derived from the points that
          chart placed and the reset from the zoom it holds, so the nodes are
          portalled out of it and nothing about them is computed twice. The
          third grid column, so filling it cannot move the pill in the second.

          Empty on chart A, which has no frame to step through and no zoom to
          undo — the same reason the period switch folds away there.
        */}
        <div ref={setChartMeta} className={styles.chartMeta} />
      </div>

      {/*
        **One box, one height, whichever chart is inside it.**

        The two charts are different shapes and always were: chart A's viewBox is
        760×284 and chart B's is 760×338, and chart B carries a head, a crosshair
        readout and a note that chart A has none of. Measured in Chrome at the
        real panel: chart A stood 719px tall and chart B 869, so switching
        question moved everything below this panel — the whole flight table — by
        **150px**. That is the reflow 12.240 refused and
        `period-switch-follows-its-chart` built a hidden strip to prevent,
        arriving by a third door: the head was fixed and the body was left free.

        So the body is the fixed thing, and the marks move inside it. A height
        rather than a `min-height`, because a floor is only half a promise — the
        taller chart would simply exceed it. The charts' own SVGs carry
        `preserveAspectRatio` at its default `xMidYMid meet`, so a drawing given a
        box of the wrong shape scales to fit and centres in it rather than
        stretching or spilling: what varies between the two is how large the
        drawing is and where its marks sit, which is exactly what is allowed to
        vary. It is also what finally centres the plot vertically, which an
        earlier pass could only do horizontally.

        Chart A is a bare figure in here now. The strip that gave it a corner
        went with the control that used to stand in it, and it was costing a row
        of height and a band of letterbox to hold a switch chart A must never
        have.
      */}
      <div className={styles.stage}>
        <div className={styles.body}>
          {view === 'moves' ? (
            <PriceBandChart
              ours={ours}
              baseline={theirs}
              unsold={oursUnsold}
              currency={currency}
              axis={axis}
              label={route ? `Cheapest fare for ${whereMonth}, by day` : 'Price analysis'}
            />
          ) : (
            /*
            Keyed by route so the crosshair the reader left on a flight resets
            when they open a different watch. The period does not reset with it —
            it is held above this component and cleared by the route change.
          */
            <DepartureChart
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
                /*
                  The route, and no months at all.

                  `accessibleTail` already appends the frame's own two dates —
                  `departing 29/03/2027 to 04/04/2027` — which is the true and
                  useful statement of what is on screen. Naming the watch here
                  as well would have a screen reader hear the months and then
                  immediately hear the dates that contradict them.
                */
                route
                  ? `What each departure date costs for ${routeLabel(route)}`
                  : 'Fares by departure date'
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
