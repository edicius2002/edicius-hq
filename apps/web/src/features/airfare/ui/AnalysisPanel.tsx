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
const WHAT: Record<string, string> = {
  moves: 'One point a day, at the price we observed.',
  'days/none': 'Nothing collected for these departure dates yet.',
  'days/boards': 'The flight boards for the watched month.',
  'days/curve': 'The booking horizon, beyond the watched month.',
  'days/mixed': 'The boards to the end of the month, then the booking horizon.',
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
  anchor,
  onAnchorChange,
  viewport,
  onViewportChange,
  leg = null,
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
    onAnchorChange(anchorFor(target, granularity, boardDays));
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
          One switch, and only one — `period-switch-follows-its-chart` superseded.

          The period switch used to stand here too, unfolding from chart B's
          button and holding its own space open by `visibility` so that folding
          away could not slide these two buttons under a pressing hand. All of
          that apparatus existed to keep a control next to a chart it governed
          only half the time. It is inside chart B now, in the chart's own
          corner, so this head asks exactly one question and its contents no
          longer change with the answer — which is the no-reflow property the
          held-open strip was built to fake, arrived at by construction instead.
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
        </div>
      </div>

      {/*
        The line naming the archive, and — on chart B only — the switch that
        belongs to chart B's tab.

        **The switch hangs off "Flights seen", and it reserves nothing.**
        `period-switch-follows-its-chart` had the placement right and the
        mechanism wrong: it stood inside `.switches`, to the right of the chart
        pill, held open by `visibility` so that folding away could not slide the
        two chart buttons under a pressing hand. That bought no-reflow by paying
        for the space permanently, on both charts, including the one that must
        never have the control at all.

        This row is the better tool for the same job. The pill above is flush
        with the panel's right edge and so is this row, so the switch lands
        directly beneath the "Flights seen" button and reads as an extension of
        it — but it is in a *different row*, so appearing and disappearing cannot
        move the pill by a pixel. Nothing is reserved: on chart A the element is
        simply not rendered, and the row is the one `.what` was already using, at
        a `min-height` it already had. The height cannot change either, because
        the switch is shorter than the two lines that floor is set to.
      */}
      <div className={styles.whatRow}>
        <p className={styles.what}>{WHAT[what]}</p>
        {view === 'days' ? (
          <PeriodSwitch granularity={granularity} onChange={onGranularityChange} />
        ) : null}
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
              viewport={viewport}
              onViewportChange={onViewportChange}
              horizonLoading={curveLoading}
              horizonError={curveError}
              leg={leg}
              label={
                route ? `What each departure date costs for ${where}` : 'Fares by departure date'
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
