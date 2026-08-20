import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { formatFlightMonth, routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useAirports } from '@/features/airfare/hooks/useAirports';
import { useFareCalendar } from '@/features/airfare/hooks/useFareCalendar';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import { type Granularity } from '@/features/airfare/lib/buckets';
import { routeGeometries } from '@/features/airfare/lib/geo';
import { routeColour } from '@/features/airfare/lib/palette';
import { cheapestDeparture, snapshotsFor } from '@/features/airfare/lib/series';
import { AnalysisPanel } from '@/features/airfare/ui/AnalysisPanel';
import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { RouteDetail } from '@/features/airfare/ui/RouteDetail';
import { ADD_ROUTE_FORM_ID } from '@/features/airfare/ui/RouteEditor';
import { RouteList } from '@/features/airfare/ui/RouteList';
import { RouteMap, type Projection } from '@/features/airfare/ui/RouteMap';
import { collectFares, type Airport, type CollectResponse } from '@/shared/api/fares';
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
  // The granularity is the page's rather than the analysis panel's because the
  // flight table under that panel is grouped by it too: two owners would let
  // the chart and the table disagree about what a week is.
  const [granularity, setGranularity] = useState<Granularity>('day');

  const watchlist = useFareRoutes(today);
  const airports = useAirports();
  const queryClient = useQueryClient();
  // Per-row collection is its own hook, not more state on this page: the
  // in-flight set, the reports and the mutation that keeps them in step are one
  // mechanism, and the page's job is to hand it to the list.
  const rowCollection = useRouteCollection();

  const selected: FareRoute | null =
    watchlist.routes.find((route) => routeId(route) === selectedId) ?? watchlist.routes[0] ?? null;
  const selectedKey = selected ? routeId(selected) : null;

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

  const collect = useMutation<CollectResponse>({
    mutationFn: () =>
      collectFares(
        watchlist.collectable.map((route) => ({
          origin: route.origin,
          destination: route.destination,
          month: route.month,
          currency: route.currency,
        })),
      ),
    // The archive just grew, so every route's series is stale — including ones
    // the reader is not looking at, which they may switch to in a second. A
    // pass can also be the first to learn where a new airport is.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fares', 'history'] });
      void queryClient.invalidateQueries({ queryKey: ['fares', 'airports'] });
    },
  });

  const failures = collect.data?.results.filter((result) => !result.ok) ?? [];

  /*
   * The skips of a pass, counted by reason.
   *
   * A watched month expands to thirty-one departures and a daily cadence polls
   * one at a time, so `skipped` is routinely the longer of the two lists — the
   * old line read "62 not due" and named a reason it had not checked. Counting
   * them keeps 8.8 honest without printing sixty lines: "60 not-due, 2
   * departed" is the whole of what happened.
   */
  const skipSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of collect.data?.skipped ?? []) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
  }, [collect.data]);

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        title="Airfare"
        actions={
          <div className={styles.collectRow}>
            <SaveStatus state={watchlist.saveState} onRetry={watchlist.retrySave} />
            <Button
              variant="primary"
              size="small"
              onClick={() => collect.mutate()}
              disabled={collect.isPending || watchlist.collectable.length === 0}
            >
              {collect.isPending ? 'Collecting…' : `Collect now (${watchlist.collectable.length})`}
            </Button>
          </div>
        }
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
            projection={projection}
            onProjectionChange={setProjection}
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
            onSelect={setSelectedId}
            onRemove={(id) => {
              if (id === selectedId) setSelectedId(null);
              // The report goes with the row. Route ids are content rather
              // than handles — the same pair on the same dates rebuilds the
              // same id — so a stale line would reappear under a route that
              // had just been added back.
              rowCollection.forget(id);
              void watchlist.remove(id);
            }}
            onCollect={rowCollection.collect}
            onAdd={(route) => void watchlist.add(route)}
            onMove={(from, to) => void watchlist.move(from, to)}
          />
        </Panel>

        {/*
            A collection pass reports what it could not do beside what it could
            — decisions 8.8 and 8.41. Hiding the refusals would make a scraper
            that stopped working look like a week of unchanged prices.
          */}
        {collect.data ? (
          <Panel>
            <h2 className={styles.panelTitle}>Last collection</h2>
            {/*
              "departures", not "routes": since 12.110 one watched route is a
              month and a pass counts the days inside it. The skipped figure
              carries its reasons rather than assuming "not due" — a month
              expands across the horizon and the days past it are skipped for a
              reason nobody can fix by waiting.
            */}
            <p className={styles.note}>
              {collect.data.collected} departure{collect.data.collected === 1 ? '' : 's'} looked at,{' '}
              {collect.data.changed} changed, {collect.data.failed} failed
              {skipSummary ? `, ${skipSummary}` : ''}.
            </p>
            {failures.length > 0 ? (
              <ul className={styles.failures}>
                {failures.map((failure) => (
                  <li key={`${failure.origin}-${failure.destination}-${failure.flightDate}`}>
                    {failure.origin} → {failure.destination} ({failure.flightDate}):{' '}
                    {failure.errorCode} — {failure.errorMessage}
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
        ) : null}

        {collect.isError ? (
          <Panel>
            <p className={styles.note} role="alert">
              The collection call failed: {collect.error.message}
            </p>
          </Panel>
        ) : null}
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
      <Panel>
        <h2 className={styles.panelTitle}>
          {selected
            ? `Flights seen departing in ${formatFlightMonth(selected.month)}`
            : 'Flights seen on this route'}
        </h2>
        <FlightTable snapshots={snapshots} granularity={granularity} />
      </Panel>
    </section>
  );
}
