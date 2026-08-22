import { useEffect, useMemo, useRef, useState } from 'react';

import { formatFlightMonth, routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useAirports } from '@/features/airfare/hooks/useAirports';
import { useFareCalendar } from '@/features/airfare/hooks/useFareCalendar';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';
import { useFareSpend } from '@/features/airfare/hooks/useFareSpend';
import { useHorizonCollection } from '@/features/airfare/hooks/useHorizonCollection';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import { useRouteView } from '@/features/airfare/hooks/useRouteView';
import { legKey, pairKey, routeGeometries } from '@/features/airfare/lib/geo';
import { routeColour } from '@/features/airfare/lib/palette';
import { pairReference } from '@/features/airfare/lib/pairReference';
import { cheapestDeparture, snapshotsFor } from '@/features/airfare/lib/series';
import { AnalysisPanel } from '@/features/airfare/ui/AnalysisPanel';
import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { RouteDetail } from '@/features/airfare/ui/RouteDetail';
import { ADD_ROUTE_FORM_ID } from '@/features/airfare/ui/RouteEditor';
import { RouteList } from '@/features/airfare/ui/RouteList';
import { RouteMap, type Projection } from '@/features/airfare/ui/RouteMap';
import { SpendToday } from '@/features/airfare/ui/SpendToday';
import type { Airport } from '@/shared/api/fares';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';
import { SaveStatus } from '@/shared/ui/SaveStatus';

import styles from './ui/AirfarePage.module.css';

// A shared empty map rather than `new Map()` inline: a fresh object every
// render would make `useMemo` recompute the whole geometry set on every keypress
// elsewhere on the page.
const EMPTY_AIRPORTS = new Map<string, Airport>();

/** Today as a calendar date, in the reader's own zone — which is when they fly. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function AirfarePage() {
  // Read once per mount rather than per render: a value that changes mid-render
  // would make the "already departed" test flip under a route the reader is
  // looking at, and nothing here needs the clock to be live.
  const [today] = useState(todayIso);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projection, setProjection] = useState<Projection>('globe');

  const watchlist = useFareRoutes();
  const airports = useAirports();
  // Per-row collection is its own hook, not more state on this page: the
  // in-flight set, the reports and the mutation that keeps them in step are one
  // mechanism, and the page's job is to hand it to the list.
  const rowCollection = useRouteCollection();
  /*
   * Adding a route collects its booking horizon — 12.247. Its own hook rather
   * than a branch of `useRouteCollection`, because it is a different pass over
   * a different unit: that one polls up to thirty-one boards for one month,
   * this one fetches one curve across every month, and the server keeps them in
   * separate slots for the same reason.
   */
  const horizon = useHorizonCollection();
  /*
   * What this address has already sent today — `spend-is-read-back-not-only-written`.
   *
   * Here rather than inside the strip that draws it, like every other query on
   * this page: the components are handed what they draw. It is also the only
   * query here that is not about a route, which is the whole reason the strip
   * sits in the header and not in a panel.
   */
  const spend = useFareSpend();

  /*
   * Which way each pair's arc flows, and which watch collected most recently.
   *
   * A pair watched both ways draws one arc — `a-pair-draws-one-arc` — so the
   * direction its dashes run in is the one thing left to say which of the two
   * legs was last looked at. `flow-follows-the-last-collected`: the arc runs
   * the way of the leg whose collection finished most recently, and where no
   * collection has finished this session it runs the way of whichever watch
   * sits higher in the watchlist, which is an order the reader owns.
   *
   * **This is the second thing that points an arc, not the first.** The open
   * route points its own arc — `the-open-watch-leads-its-arc` — so what is
   * recorded here decides every arc the reader does not have open, which is
   * every arc but one. The two never contend for the same line: the open arc
   * takes the selection, the rest take this.
   *
   * **This is the live signal, and it costs nothing.** The page cannot ask the
   * archive when each leg was last collected: `/api/fares/history` answers one
   * city pair at a time and is fetched for the open route alone, so learning
   * this from the server would be one request per watched route on every page
   * load, to move a dash pattern. What the page *does* already know is the
   * exact moment a pass it started came to an end — both collection hooks poll
   * their pass to completion and drop the route from `collecting` when it
   * stops — and that is the only moment in a session when a leg's fares
   * genuinely become newer than the other leg's. So the direction is read off
   * the passes this tab watched, in memory, with no refresh and no extra call.
   *
   * What it therefore does not survive is a reload: a fresh page has watched
   * no passes and every arc goes back to watchlist order. That is honest
   * rather than cheap — after a reload nothing in this tab has seen a leg
   * collected, and pretending otherwise would need the per-route figures this
   * paragraph declines to fetch.
   */
  const [flow, setFlow] = useState<{ legs: Map<string, string>; freshest: string | null }>(() => ({
    legs: new Map<string, string>(),
    freshest: null,
  }));
  /*
   * Which routes were mid-pass on the last run of the effect below.
   *
   * A ref rather than state, because it exists only to be compared against —
   * a route that was in `collecting` and is not any more is a pass that ended,
   * whichever way it ended. Holding it as state would re-render the page every
   * time a pass started as well, for a value nothing draws.
   *
   * A failed pass counts. It is still the leg the reader most recently asked
   * about, the arc still points at what they were looking at, and a direction
   * that only moved on success would leave a refusal looking like nothing had
   * happened at all.
   */
  const passing = useRef<readonly string[]>([]);
  useEffect(() => {
    const running = new Set([...rowCollection.collecting, ...horizon.collecting]);
    const ended = passing.current.filter((id) => !running.has(id));
    passing.current = [...running];
    if (ended.length === 0) return;
    setFlow((current) => {
      const legs = new Map(current.legs);
      let freshest = current.freshest;
      for (const id of ended) {
        // A route removed while its pass was still running has no direction to
        // record and no arc left to point: it is simply skipped, and the pair
        // falls back to whatever its remaining watch says.
        const route = watchlist.routes.find((watched) => routeId(watched) === id);
        if (!route) continue;
        legs.set(pairKey(route.origin, route.destination), legKey(route.origin, route.destination));
        freshest = id;
      }
      return { legs, freshest };
    });
  }, [horizon.collecting, rowCollection.collecting, watchlist.routes]);

  const selected: FareRoute | null =
    watchlist.routes.find((route) => routeId(route) === selectedId) ?? watchlist.routes[0] ?? null;
  const selectedKey = selected ? routeId(selected) : null;

  /*
   * How this route was last read: its period, its place in the archive, and its
   * zoom.
   *
   * Here rather than in the analysis panel because the flight table under that
   * panel is grouped by the same period — two owners would let the chart and the
   * table disagree about what a week is. Per route rather than per page because
   * a watch is what the reader is comparing: opening a second one and coming
   * back should leave the first as it was, which is a thing the old single
   * granularity and the panel's own cleared-on-change anchor together could not
   * do.
   *
   * The month goes down with the key because it is what a route that has never
   * been opened is read as — the whole watched month, on the month it is watched
   * for, `a-watch-opens-on-its-own-month`. It is the seed for a reading that does
   * not exist yet and nothing else: a route the reader has already set a period
   * on is handed back that period whatever month it is watching.
   */
  const {
    view: routeView,
    setGranularity,
    setAnchor,
    setViewport,
  } = useRouteView(selectedKey, selected?.month ?? null);
  const granularity = routeView.granularity;

  const history = useFareHistory(selected);
  // Beside the archive rather than inside the panel that draws it: the two are
  // the same kind of thing — one route's data, fetched where the route is
  // chosen — and the panel stays a component that is handed everything it
  // draws. `useFareCalendar` records why it is not gated on the open view.
  const calendar = useFareCalendar(selected);

  /*
   * What this route is being read as: its month — 12.260.
   *
   * This was `readingPrefix`, which answered the month or the one day inside
   * it the reader had focused. A watch names no day now, so there is one
   * answer; `snapshotsFor` still narrows with `startsWith` because `YYYY-MM`
   * is a prefix of every departure key inside it — 12.112.
   */
  const reading = selected ? selected.month : null;

  const snapshots = useMemo(
    () =>
      selected && reading && history.data ? snapshotsFor(history.data.snapshots, reading) : [],
    [history.data, selected, reading],
  );
  /*
   * What this city pair usually costs — the one figure on this page built from
   * the archive rather than from the reading.
   *
   * **Here and not in the panel, because here is the last place that still has
   * the whole pair.** `fetchFareHistory` returns every snapshot the pair has
   * ever had, whatever `departure` narrowing the baseline and the health counts
   * got; `snapshotsFor` above throws all but the watched month away, and
   * everything below this line is about that month. A reference computed after
   * the narrowing would be a median of what is already on screen, which sits in
   * the middle of what is on screen and tells the reader nothing —
   * `lib/pairReference.ts` carries the argument in full.
   *
   * Dated with `todayIso`, which is the same clock the add form's earliest
   * departure uses: this figure is worked out afresh every time the page is
   * read, and the date is how it admits that.
   */
  const reference = useMemo(
    () => pairReference(history.data?.snapshots ?? [], todayIso()),
    [history.data],
  );

  // The board the detail panel describes: the cheapest departure in the
  // watched month as it was last seen, not the last snapshot written — that
  // one belongs to whichever departure the collector reached last, which says
  // something about the pacing and nothing about the fares.
  const latest = useMemo(() => cheapestDeparture(snapshots), [snapshots]);
  const insights = latest?.insights ?? null;
  const health = history.data?.health ?? null;

  /*
   * The arcs, pointed by the open route first and by the last collection after.
   *
   * `selectedKey` rather than `selectedId`: the open route is the one this page
   * is actually showing — the one the detail panel describes, the one the
   * watchlist marks and the one the map thickens — and with `selectedId` at
   * null that is the first row rather than nothing. Handing the raw state down
   * would leave the arc pointed one way and every other thing on the page
   * talking about the other.
   *
   * The selection reaches `lib/geo` rather than `RouteMap` because direction is
   * a property of the geometry here: the keyframes always travel towards the
   * path's end, so the only way to turn an arc round is to swap its `from` and
   * its `to`, and that is done where the arc is built.
   */
  const geometries = useMemo(
    () =>
      routeGeometries(
        watchlist.routes.map((route) => ({
          id: routeId(route),
          origin: route.origin,
          destination: route.destination,
        })),
        airports.data ?? EMPTY_AIRPORTS,
        flow.legs,
        selectedKey,
      ),
    [watchlist.routes, airports.data, flow.legs, selectedKey],
  );

  /*
   * How many watched routes have no arc, counted in watches rather than arcs.
   *
   * `geometries.length` was the count before `a-pair-draws-one-arc`, and it
   * cannot be any more: one arc can now stand for two watches, so subtracting
   * arcs from routes would report a route "not drawn yet" the moment a return
   * leg was added — a note about missing coordinates raised by a route whose
   * coordinates are on screen.
   */
  const undrawn =
    watchlist.routes.length - geometries.reduce((total, arc) => total + arc.watches.length, 0);

  /*
   * A colour per route, by its place in the watchlist.
   *
   * This used to be a cheap/dear tone on the open route alone, which left
   * every other arc in the same accent — and this page draws them all from one
   * origin, so they left Lima as a fan of identical lines. Colour is identity
   * now; how a fare sits against its usual price is the detail panel's job,
   * where there is room to say it in words and a number.
   *
   * Built from the watchlist rather than from the drawn geometries, so a route
   * whose coordinates have not arrived yet still holds its slot and the arcs
   * do not renumber when one of them appears.
   *
   * Still one colour per **watch**, and an arc still draws only one of them —
   * its first in watchlist order, `colour-holds-the-first-watch`. So on a pair
   * watched both ways the second row's colour is in this map and on no line,
   * which is what a single arc standing for two watches costs. The row still
   * carries it, which is where a watch is a thing you can count.
   */
  const colours = useMemo(() => {
    const map = new Map<string, string>();
    watchlist.routes.forEach((route, index) => map.set(routeId(route), routeColour(index)));
    return map;
  }, [watchlist.routes]);

  /*
   * The open route's two cities, read straight from the airports.
   *
   * This used to come off the drawn geometry, and it cannot any more: an arc
   * names the leg it is currently flowing along, and only the arc holding the
   * open watch is guaranteed to be flowing along that one. The detail panel
   * underneath says "Santiago to Lima" about the route the reader has open, so
   * it has to ask about that route rather than about the line drawn for its
   * pair — a question that stays answerable while the watchlist is loading and
   * there is no geometry at all.
   *
   * Asking the airport table directly is also the simpler question. The map's
   * geometry was only ever a place these two strings happened to be sitting.
   */
  const cities = useMemo(() => {
    const known = airports.data;
    if (!selected || !known) return { from: null, to: null };
    return {
      from: known.get(selected.origin)?.city ?? null,
      to: known.get(selected.destination)?.city ?? null,
    };
  }, [airports.data, selected]);

  /*
   * The open route as the two panels that link out to airlines need it.
   *
   * Assembled once here rather than twice at the two call sites, because the
   * country is the awkward half: a `FareRoute` carries the city pair and
   * nothing else, and which storefront a carrier's booking search opens in is
   * decided by the origin airport's country, which lives on the airports table
   * this page already holds for the map. Two copies of that lookup would be two
   * places for the chart and the table to start disagreeing about whether a
   * flight is reachable.
   *
   * Memoised because the chart depends on its identity: it is a dependency of
   * the memo that builds ~899 `<circle>` elements, and a fresh literal each
   * render would rebuild all of them on every pointer move.
   *
   * Null until both are known, which draws no links rather than links into a
   * storefront picked by guesswork.
   */
  const leg = useMemo(
    () =>
      selected === null
        ? null
        : {
            origin: selected.origin,
            destination: selected.destination,
            originCountry: airports.data?.get(selected.origin)?.country ?? null,
          },
    [selected, airports.data],
  );

  return (
    <section className={styles.page} aria-labelledby="page-title">
      {/*
        A title and nothing beside it.

        The page-wide "Collect now" is withdrawn rather than fixed. It had been
        wrong since 12.210 in a way that is invisible from the outside: the
        press used to hold the connection open for the length of the pass, and
        once the pass moved onto the server's own task the same call returned in
        milliseconds — so the button flashed "Collecting…" for an instant, the
        archive's queries were invalidated at the moment the pass *started* and
        refetched exactly what was already on screen, and the "Last collection"
        panel underneath described a pass with no results in it yet, every time.

        What replaced it is per-row and was always the better shape. A press on
        a row says which month it means; this one meant "everything", which the
        server was going to reduce to whatever the cadence allowed anyway, and
        the reader could not see which part of "everything" was moving. The row
        watches its own pass to the end and draws it.
      */}
      {/*
        A title, and beside it the one fact on this page that is about **us**.

        The paragraph above still stands: nothing that *acts* belongs here, and
        the page-wide press is not coming back. What sits at the far end of the
        row now is a reading rather than a control — how many upstream requests
        this address has sent today, beside the busiest day anybody has measured,
        which since the daily ceiling went is the only number to read it against. It is the alarm for a collector that is
        about to run every fifteen minutes with nobody watching, and the header
        is the only part of this page that is about the page rather than about a
        route. `SpendToday` argues the placement out in full.
      */}
      <PageHeader
        title="Airfare"
        actions={<SpendToday spend={spend.data} loading={spend.isPending} />}
      />

      {/*
        Four cells, laid out in order: map and watchlist across the top row,
        route detail and the collection report under them. The panels are grid
        children rather than two stacked columns, which is what makes the map
        and the watchlist share a row — and so a height — instead of each
        column growing to its own content.
      */}
      <div className={styles.top}>
        <Panel className={styles.tall}>
          <RouteMap
            routes={geometries}
            selectedId={selectedKey}
            onSelect={setSelectedId}
            colours={colours}
            lastCollectedId={flow.freshest}
            projection={projection}
            onProjectionChange={setProjection}
            /*
              The watchlist's save state, in the map's toolbar — which is not
              where it belongs by subject but is where it belongs on screen.
              It stood in the page header beside the collect button; with that
              button withdrawn the header was a title and a word floating at the
              far end of an empty row. The two panels below it already carry
              their own chrome, and this one had a strip with room on it.
            */
            status={<SaveStatus state={watchlist.saveState} onRetry={watchlist.retrySave} />}
          />
          {undrawn > 0 ? (
            <p className={styles.note}>
              {undrawn} route{undrawn === 1 ? '' : 's'} not drawn yet — coordinates arrive with a
              route&rsquo;s first collection.
            </p>
          ) : null}
        </Panel>

        <Panel className={styles.tall}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Watched routes</h2>
            {/*
              Outside the form it submits, which is what `form` is for: the
              action belongs at the top of the panel it acts on, not buried
              under the fields.
            */}
            <Button type="submit" form={ADD_ROUTE_FORM_ID} variant="primary" size="small">
              Add route
            </Button>
          </header>
          <RouteList
            routes={watchlist.routes}
            colours={colours}
            selectedId={selectedKey}
            today={today}
            collecting={rowCollection.collecting}
            reports={rowCollection.reports}
            progress={rowCollection.progress}
            onSelect={setSelectedId}
            onRemove={(id) => {
              if (id === selectedId) setSelectedId(null);
              // The report goes with the row. Route ids are content rather
              // than handles — the same pair on the same dates rebuilds the
              // same id — so a stale line would reappear under a route that
              // had just been added back.
              rowCollection.forget(id);
              horizon.forget(id);
              void watchlist.remove(id);
            }}
            onCollect={rowCollection.collect}
            /*
              The add lands first and the horizon collection follows it, never
              the other way round — 12.247. The add is a write to the reader's
              own document and this is a request to somebody else's server; a
              route that failed to save because a fare lookup failed would let
              an upstream veto a watchlist edit, and the reader would have no
              row left to retry from. So the route is watched either way and the
              collection reports itself below.
            */
            onAdd={(route) => {
              void watchlist.add(route).then(() => horizon.collect(route));
            }}
            onMove={(from, to) => void watchlist.move(from, to)}
          />
          {/*
            The horizon reports, coloured by what they say.

            This list was `styles.failures`, and that class paints every line in
            `--color-expense` unconditionally — so a horizon collected perfectly,
            three hundred dates priced and not a refusal in sight, was printed in
            red. The owner reported errors they did not have, and this is a large
            part of why. `RowReport` has carried `ok` since it was written and
            nothing here was reading it.

            The rule is the row list's, taken rather than reinvented: the line is
            muted by default and red only when `!report.ok`. Two lists reporting
            the same kind of outcome in two colour schemes would be the same
            fault waiting to come back.
          */}
          {horizon.reports.size > 0 ? (
            <ul className={styles.reports} data-testid="horizon-reports">
              {[...horizon.reports.entries()].map(([id, report]) => {
                const bar = horizon.progress.get(id) ?? null;
                return (
                  <li key={id}>
                    {/*
                      The bar above the words, and only while a pass is
                      running. `horizonProgress` returns null for a pass that
                      has stopped, for somebody else's, and for one that
                      settled at nothing to do — so a track in the document at
                      all means work is genuinely in flight.

                      `aria-hidden`, with no `progressbar` role and no figures
                      on it: the sentence underneath already says how many
                      windows have been priced and how many requests it took,
                      and a bar carrying the same numbers would make a screen
                      reader hear the pass twice. The row list settled this
                      question the same way.
                    */}
                    {bar ? (
                      <span
                        className={
                          bar.fraction === null
                            ? `${styles.progress} ${styles.unplanned}`
                            : styles.progress
                        }
                        data-testid={`horizon-progress-${id}`}
                        aria-hidden="true"
                      >
                        <span
                          className={styles.fill}
                          style={
                            bar.fraction === null
                              ? undefined
                              : { width: `${Math.min(1, bar.fraction) * 100}%` }
                          }
                        />
                      </span>
                    ) : null}
                    <span className={report.ok ? undefined : styles.refused}>{report.text}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Panel>

        {/*
          "Last collection" stood here and is withdrawn with the button that
          filled it. It said what a pass looked at, changed, failed and skipped
          — decisions 8.8 and 8.41, and none of that rule is abandoned: what a
          press could not do still travels beside what it could, on the row that
          pressed. What went is the panel, which since 12.210 was reporting a
          document read at the instant the pass began and so printed "0
          departures looked at, 0 changed, 0 failed" for every press.
        */}
      </div>

      {/*
        The route's own figures, across the page and one strip tall. At this
        width a stacked column of four numbers is mostly empty space with
        everything below it pushed down.
      */}
      <Panel>
        <RouteDetail
          route={selected}
          latest={latest}
          insights={insights}
          health={health}
          cities={cities}
          /*
            The whole panel is derived from `history.data`, and a query whose
            key has just changed has none — so choosing a second route made the
            strip claim, for the length of the request, that the first thing it
            had ever been asked about had never been collected. The same wiring
            the analysis panel got in 12.237, for the same reason.
          */
          loading={history.isPending}
        />
      </Panel>

      {/*
        The analysis runs the full width, under both columns. Its own component
        since 12.170: the three views, the two switches and the period the
        reader is on are one mechanism, and the period has to outlive the view
        that shows it — which it cannot do if it is state inside one of them.
      */}
      <Panel>
        <AnalysisPanel
          route={selected}
          snapshots={snapshots}
          baseline={history.data?.baseline ?? []}
          curve={calendar.data?.horizon ?? null}
          /*
            `isPending` is false on a failed query, so passing it alone left a
            500 from `/api/fares/calendar` rendering as "no booking horizon
            collected for this route yet" — a fault at our end reported as a
            fact about the route's fares. Both halves of the query's state now
            travel, and the chart has three branches rather than two — 12.237.
          */
          curveLoading={calendar.isPending}
          curveError={calendar.error}
          reference={reference}
          granularity={granularity}
          onGranularityChange={setGranularity}
          anchor={routeView.anchor}
          onAnchorChange={setAnchor}
          viewport={routeView.viewport}
          onViewportChange={setViewport}
          /*
            And the leg, which chart B needs for one thing: which of its marks
            can be reached at their own airline, and where the flight number in
            the line under the plot links to.
          */
          leg={leg}
        />
      </Panel>

      {/*
        Its own panel rather than a heading inside the chart's. The chart
        answers "is this route cheaper than usual"; the table answers "cheaper
        on what, and which ones moved". Two questions, two boxes.

        The same granularity drives both, so the switch above moves the table's
        period with the chart's last bucket — a table of the whole archive
        under a chart of one day would be two answers to one question.
      */}
      {/*
        The heading is the table's own, and it is the only panel here where it
        is — 12.257. The owner wants it on the filter row rather than above it,
        and a heading in this file cannot share a line with controls rendered
        in another. All that crosses the boundary is the departure the reader
        picked, already formatted: `FlightTable` writes the words.
      */}
      <Panel>
        {/*
          The heading moved into the table with 12.257, onto the filter row —
          so what this page hands over is the departure in words rather than a
          sentence around it. `formatFlightMonth(selected.month)` where that
          was `formatReading`: a watch names a month and nothing narrower
          (12.260), so the table's name is `Flights seen · March 2027` and can
          no longer be a single date over a month of rows.
        */}
        {/*
          And the leg, which the table needs for one thing only: the link from
          each row's flight number out to that airline's own booking search. A
          row carries its carrier and its departure stamp and nothing about the
          city pair, and the origin's country is not in the archive at all — it
          is on the airports table this page already holds for the map. It is
          the same object the analysis panel above is given, so the two panels
          cannot disagree about which flights are reachable.
        */}
        <FlightTable
          snapshots={snapshots}
          granularity={granularity}
          departure={selected ? formatFlightMonth(selected.month) : null}
          leg={leg}
        />
      </Panel>
    </section>
  );
}
