import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';
import {
  byAirline,
  cheapestSeries,
  daysBeforeDeparture,
  latestSnapshot,
  priceStats,
  snapshotsFor,
} from '@/features/airfare/lib/series';
import { FlightTable } from '@/features/airfare/ui/FlightTable';
import { PriceHistoryChart } from '@/features/airfare/ui/PriceHistoryChart';
import { RouteEditor } from '@/features/airfare/ui/RouteEditor';
import { RouteList } from '@/features/airfare/ui/RouteList';
import { collectFares, type CollectResponse } from '@/shared/api/fares';
import { formatMoney, formatSignedAmount, NO_VALUE } from '@/shared/lib/money';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';
import { SaveStatus } from '@/shared/ui/SaveStatus';
import { Stat } from '@/shared/ui/Stat';

import styles from './ui/AirfarePage.module.css';

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

  const watchlist = useFareRoutes(today);
  const queryClient = useQueryClient();

  const selected: FareRoute | null =
    watchlist.routes.find((route) => routeId(route) === selectedId) ?? watchlist.routes[0] ?? null;

  const history = useFareHistory(selected);

  const snapshots = useMemo(
    () =>
      selected && history.data
        ? snapshotsFor(history.data.snapshots, selected.flightDate, selected.returnDate)
        : [],
    [history.data, selected],
  );
  const points = useMemo(() => cheapestSeries(snapshots), [snapshots]);
  // The provider's own daily series, and whether the collector has been
  // looking. Both arrive with the history, so neither costs a request.
  const baseline = useMemo(
    () =>
      (history.data?.baseline ?? []).map((point) => ({
        capturedAt: point.date,
        price: point.price,
        currency: selected?.currency ?? 'USD',
      })),
    [history.data, selected],
  );
  const health = history.data?.health ?? null;
  const stats = useMemo(() => priceStats(points), [points]);
  const latest = useMemo(() => latestSnapshot(snapshots), [snapshots]);
  const carriers = useMemo(() => byAirline(latest), [latest]);

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
    // the reader is not looking at, which they may switch to in a second.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fares', 'history'] }),
  });

  const currency = selected?.currency ?? 'USD';
  const daysOut =
    selected && latest ? daysBeforeDeparture(latest.capturedAt, selected.flightDate) : null;
  const failures = collect.data?.results.filter((result) => !result.ok) ?? [];

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        title="Airfare"
        subtitle="Track what a route costs, one observation a day."
        actions={
          <div className={styles.collectRow}>
            <SaveStatus state={watchlist.saveState} onRetry={watchlist.retrySave} />
            <Button
              variant="primary"
              onClick={() => collect.mutate()}
              disabled={collect.isPending || watchlist.collectable.length === 0}
            >
              {collect.isPending ? 'Collecting…' : `Collect now (${watchlist.collectable.length})`}
            </Button>
          </div>
        }
      />

      <div className={styles.layout}>
        <div className={styles.column}>
          <Panel>
            <h2 className={styles.panelTitle}>Watched routes</h2>
            <RouteList
              routes={watchlist.routes}
              selectedId={selected ? routeId(selected) : null}
              today={today}
              onSelect={setSelectedId}
              onRemove={(id) => {
                if (id === selectedId) setSelectedId(null);
                void watchlist.remove(id);
              }}
            />
          </Panel>

          <Panel>
            <h2 className={styles.panelTitle}>Add a route</h2>
            <RouteEditor today={today} onAdd={(route) => void watchlist.add(route)} />
          </Panel>
        </div>

        <div className={styles.column}>
          <Panel>
            <h2 className={styles.panelTitle}>
              {selected
                ? `${routeLabel(selected)} · departs ${selected.flightDate}`
                : 'Price history'}
            </h2>

            {selected ? (
              <>
                <div className={styles.stats}>
                  <Stat
                    label="Latest"
                    value={stats ? formatMoney(stats.latest, currency) : NO_VALUE}
                    tone="accent"
                  />
                  <Stat
                    label="Lowest seen"
                    value={stats ? formatMoney(stats.lowest, currency) : NO_VALUE}
                    tone="income"
                  />
                  <Stat
                    label="Highest seen"
                    value={stats ? formatMoney(stats.highest, currency) : NO_VALUE}
                    tone="expense"
                  />
                  <Stat
                    label="Vs median"
                    value={
                      stats?.deltaVsMedian === null || stats === null
                        ? NO_VALUE
                        : formatSignedAmount(stats.deltaVsMedian)
                    }
                    // Below its own median is the buy signal, so it reads as income.
                    tone={
                      stats?.deltaVsMedian != null && stats.deltaVsMedian < 0 ? 'income' : 'default'
                    }
                  />
                  <Stat label="Observations" value={stats?.observations ?? 0} />
                </div>

                <PriceHistoryChart
                  points={points}
                  baseline={baseline}
                  currency={currency}
                  label={`Cheapest fare for ${routeLabel(selected)} departing ${selected.flightDate}`}
                />

                {baseline.length > 0 ? (
                  <p className={styles.note}>
                    The dashed line is the provider's own daily history — {baseline.length} day
                    {baseline.length === 1 ? '' : 's'} of it, rounded and cheapest-only, seeded when
                    this route was first watched.
                  </p>
                ) : null}

                {daysOut !== null ? (
                  <p className={styles.note}>
                    Last observed {daysOut} day{daysOut === 1 ? '' : 's'} before departure.
                  </p>
                ) : null}

                {/*
                  A run of the archive with no new points means either no price
                  movement or no collector, and only the heartbeat count tells
                  them apart. Saying so is what makes the quiet readable.
                */}
                {health ? (
                  <p className={styles.note}>
                    {health.checks} look{health.checks === 1 ? '' : 's'} taken, {health.changes} of
                    them found a change
                    {health.errors > 0 ? `, ${health.errors} failed` : ''}
                    {health.lastCheckedAt
                      ? `. Last looked at ${health.lastCheckedAt.slice(0, 16).replace('T', ' ')}.`
                      : '.'}
                  </p>
                ) : null}
              </>
            ) : (
              <p className={styles.note}>Add a route to start building its history.</p>
            )}
          </Panel>

          <Panel>
            <h2 className={styles.panelTitle}>Latest itineraries</h2>
            <FlightTable snapshots={snapshots} />
            {carriers.length > 0 ? (
              <p className={styles.note}>
                {carriers.length} carrier{carriers.length === 1 ? '' : 's'}, cheapest{' '}
                {carriers[0].airlineName ?? carriers[0].airline} at{' '}
                {formatMoney(carriers[0].cheapest, currency)}.
              </p>
            ) : null}
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
                {collect.data.collected} collected, {collect.data.failed} failed, via{' '}
                {collect.data.source}.
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
    </section>
  );
}
