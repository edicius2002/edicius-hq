import { useMemo, useState } from 'react';

import { formatFlightMonth, routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useAirports } from '@/features/airfare/hooks/useAirports';
import { useFareCalendar } from '@/features/airfare/hooks/useFareCalendar';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';
import { useHorizonCollection } from '@/features/airfare/hooks/useHorizonCollection';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import { useRouteView } from '@/features/airfare/hooks/useRouteView';
import { routeGeometries } from '@/features/airfare/lib/geo';
import { routeColour } from '@/features/airfare/lib/palette';
import { cheapestDeparture, snapshotsFor } from '@/features/airfare/lib/series';
import { AnalysisPanel } from '@/features/airfare/ui/AnalysisPanel';
import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { RouteDetail } from '@/features/airfare/ui/RouteDetail';
import { ADD_ROUTE_FORM_ID } from '@/features/airfare/ui/RouteEditor';
import { RouteList } from '@/features/airfare/ui/RouteList';
import { RouteMap, type Projection } from '@/features/airfare/ui/RouteMap';
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
   */
  const { view: routeView, setGranularity, setAnchor, setViewport } = useRouteView(selectedKey);
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
  // The board the detail panel describes: the cheapest departure in the
  // watched month as it was last seen, not the last snapshot written — that
  // one belongs to whichever departure the collector reached last, which says
  // something about the pacing and nothing about the fares.
  const latest = useMemo(() => cheapestDeparture(snapshots), [snapshots]);
  const insights = latest?.insights ?? null;
  const health = history.data?.health ?? null;

  const geometries = useMemo(
    () =>
      routeGeometries(
        watchlist.routes.map((route) => ({
          id: routeId(route),
          origin: route.origin,
          destination: route.destination,
        })),
        airports.data ?? EMPTY_AIRPORTS,
      ),
    [watchlist.routes, airports.data],
  );

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
   */
  const colours = useMemo(() => {
    const map = new Map<string, string>();
    watchlist.routes.forEach((route, index) => map.set(routeId(route), routeColour(index)));
    return map;
  }, [watchlist.routes]);

  const cities = useMemo(() => {
    const found = geometries.find((geometry) => geometry.id === selectedKey);
    return { from: found?.fromCity ?? null, to: found?.toCity ?? null };
  }, [geometries, selectedKey]);

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
      <PageHeader title="Airfare" />

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
          {geometries.length < watchlist.routes.length ? (
            <p className={styles.note}>
              {watchlist.routes.length - geometries.length} route
              {watchlist.routes.length - geometries.length === 1 ? '' : 's'} not drawn yet —
              coordinates arrive with a route&rsquo;s first collection.
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
          {horizon.reports.size > 0 ? (
            <ul className={styles.failures} data-testid="horizon-reports">
              {[...horizon.reports.entries()].map(([id, report]) => (
                <li key={id}>{report.text}</li>
              ))}
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
          curve={calendar.data?.latest ?? null}
          /*
            `isPending` is false on a failed query, so passing it alone left a
            500 from `/api/fares/calendar` rendering as "no booking horizon
            collected for this route yet" — a fault at our end reported as a
            fact about the route's fares. Both halves of the query's state now
            travel, and the chart has three branches rather than two — 12.237.
          */
          curveLoading={calendar.isPending}
          curveError={calendar.error}
          granularity={granularity}
          onGranularityChange={setGranularity}
          anchor={routeView.anchor}
          onAnchorChange={setAnchor}
          viewport={routeView.viewport}
          onViewportChange={setViewport}
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
        <FlightTable
          snapshots={snapshots}
          granularity={granularity}
          departure={selected ? formatFlightMonth(selected.month) : null}
        />
      </Panel>
    </section>
  );
}
