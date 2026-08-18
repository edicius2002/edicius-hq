import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useAirports } from '@/features/airfare/hooks/useAirports';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';
import { bucketBaseline, bucketSnapshots, type Granularity } from '@/features/airfare/lib/buckets';
import { variation } from '@/features/airfare/lib/flights';
import { routeGeometries } from '@/features/airfare/lib/geo';
import { latestSnapshot, snapshotsFor } from '@/features/airfare/lib/series';
import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { PriceBandChart } from '@/features/airfare/ui/PriceBandChart';
import { RouteDetail } from '@/features/airfare/ui/RouteDetail';
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

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

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
  const [granularity, setGranularity] = useState<Granularity>('day');

  const watchlist = useFareRoutes(today);
  const airports = useAirports();
  const queryClient = useQueryClient();

  const selected: FareRoute | null =
    watchlist.routes.find((route) => routeId(route) === selectedId) ?? watchlist.routes[0] ?? null;
  const selectedKey = selected ? routeId(selected) : null;

  const history = useFareHistory(selected);

  const snapshots = useMemo(
    () =>
      selected && history.data
        ? snapshotsFor(history.data.snapshots, selected.flightDate, selected.returnDate)
        : [],
    [history.data, selected],
  );
  const latest = useMemo(() => latestSnapshot(snapshots), [snapshots]);
  const insights = latest?.insights ?? null;
  const health = history.data?.health ?? null;
  const currency = selected?.currency ?? 'USD';

  const ourBuckets = useMemo(
    () => bucketSnapshots(snapshots, granularity),
    [snapshots, granularity],
  );
  const baselineBuckets = useMemo(
    () => bucketBaseline(history.data?.baseline ?? [], granularity),
    [history.data, granularity],
  );

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
   * Only the open route is coloured by how far it sits from its usual price.
   *
   * Colouring every arc would mean a history request per watched route — the
   * page holds one route's archive at a time by design. A summary endpoint
   * would fix that; until there is one, a neutral arc honestly means "not
   * looked up" rather than "around usual".
   */
  const tones = useMemo(() => {
    const map = new Map<string, string>();
    const cheapest = latest?.offers.length
      ? Math.min(...latest.offers.map((offer) => offer.price))
      : null;
    const typical = insights?.typical ?? null;
    if (selectedKey && cheapest !== null && typical !== null) {
      const delta = variation(typical, cheapest);
      map.set(
        selectedKey,
        delta === null ? 'neutral' : delta <= -8 ? 'cheap' : delta >= 8 ? 'dear' : 'neutral',
      );
    }
    return map;
  }, [latest, insights, selectedKey]);

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
          flightDate: route.flightDate,
          returnDate: route.returnDate,
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

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        title="Airfare"
        subtitle="Watch what a route costs, and notice when it moves."
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

      {/* Map and its route detail on the left, the watchlist on the right. */}
      <div className={styles.top}>
        <div className={styles.stack}>
          <Panel>
            <RouteMap
              routes={geometries}
              selectedId={selectedKey}
              onSelect={setSelectedId}
              tones={tones}
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

          <Panel>
            <RouteDetail
              route={selected}
              latest={latest}
              insights={insights}
              health={health}
              cities={cities}
            />
          </Panel>
        </div>

        <div className={styles.stack}>
          <Panel>
            <h2 className={styles.panelTitle}>Watched routes</h2>
            <RouteList
              routes={watchlist.routes}
              selectedId={selectedKey}
              today={today}
              onSelect={setSelectedId}
              onRemove={(id) => {
                if (id === selectedId) setSelectedId(null);
                void watchlist.remove(id);
              }}
              onAdd={(route) => void watchlist.add(route)}
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
              <p className={styles.note}>
                {collect.data.collected} looked at, {collect.data.changed} changed,{' '}
                {collect.data.failed} failed
                {collect.data.skipped.length > 0 ? `, ${collect.data.skipped.length} not due` : ''}.
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
      </div>

      {/* The analysis runs the full width, under both columns. */}
      <Panel>
        <div className={styles.analysisHead}>
          <h2 className={styles.panelTitle}>
            {selected
              ? `${routeLabel(selected)} · departs ${selected.flightDate}`
              : 'Price analysis'}
          </h2>
          <div className={styles.switch} role="group" aria-label="Group observations by">
            {GRANULARITIES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={granularity === option.value}
                onClick={() => setGranularity(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <PriceBandChart
          ours={ourBuckets}
          baseline={baselineBuckets}
          currency={currency}
          granularity={granularity}
          label={
            selected
              ? `Cheapest fare for ${routeLabel(selected)} departing ${selected.flightDate}, by ${granularity}`
              : 'Price analysis'
          }
        />

        <h3 className={styles.subTitle}>Every flight seen on this route</h3>
        <FlightTable snapshots={snapshots} />
      </Panel>
    </section>
  );
}
