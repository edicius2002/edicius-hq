import { variation } from '@/features/airfare/lib/flights';
import { departureClock } from '@/features/airfare/lib/series';
import type { FareInsights, FareSnapshot, WatchHealth } from '@/shared/api/fares';
import { formatMoney, NO_VALUE } from '@/shared/lib/money';

import styles from './RouteDetail.module.css';

type RouteDetailProps = {
  route: { origin: string; destination: string; flightDate: string; currency: string } | null;
  latest: FareSnapshot | null;
  insights: FareInsights | null;
  health: WatchHealth | null;
  cities: { from: string | null; to: string | null };
};

/**
 * What this route costs right now, and whether that is a lot.
 *
 * Four figures and a sentence. The chart underneath answers "how has it moved";
 * this answers "what is it, and should I care today" — which is the question a
 * watchlist exists for, and the one a reader should not have to read a chart to
 * get.
 *
 * `vs usual` is the only figure here that is a judgement rather than a
 * measurement, and it leans on the provider's own baseline rather than ours:
 * two months of context on the day a route is added, where our own median needs
 * two months of collecting to mean anything.
 */
export function RouteDetail({ route, latest, insights, health, cities }: RouteDetailProps) {
  if (!route) {
    return <p className={styles.empty}>Add a route to start building its history.</p>;
  }

  const offers = latest?.offers ?? [];
  const cheapest = offers.length ? offers.reduce((a, b) => (a.price <= b.price ? a : b)) : null;
  const dearest = offers.length ? offers.reduce((a, b) => (a.price >= b.price ? a : b)) : null;
  const typical = insights?.typical ?? null;
  const vsUsual = cheapest && typical ? variation(typical, cheapest.price) : null;
  const airlines = new Set(offers.map((offer) => offer.airline)).size;
  const tone =
    vsUsual === null ? 'neutral' : vsUsual <= -8 ? 'cheap' : vsUsual >= 8 ? 'dear' : 'neutral';

  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        <h3 className={styles.pair}>
          {route.origin} <span className={styles.to}>→</span> {route.destination}
        </h3>
        <p className={styles.cities}>
          {cities.from ?? route.origin} to {cities.to ?? route.destination} · departs{' '}
          {route.flightDate}
        </p>
      </header>

      <dl className={styles.figures}>
        <div>
          <dt>Cheapest now</dt>
          <dd className={styles.big}>
            {cheapest ? formatMoney(cheapest.price, route.currency) : NO_VALUE}
          </dd>
        </div>
        <div>
          <dt>Dearest on board</dt>
          <dd>{dearest ? formatMoney(dearest.price, route.currency) : NO_VALUE}</dd>
        </div>
        <div>
          <dt>Usually</dt>
          <dd>{typical ? formatMoney(typical, route.currency) : NO_VALUE}</dd>
        </div>
        <div>
          <dt>Vs usual</dt>
          <dd className={styles[tone]}>
            {vsUsual === null ? NO_VALUE : `${vsUsual > 0 ? '+' : ''}${vsUsual.toFixed(1)}%`}
          </dd>
        </div>
      </dl>

      {cheapest ? (
        <p className={styles.note}>
          {offers.length} itinerar{offers.length === 1 ? 'y' : 'ies'}, {airlines} airline
          {airlines === 1 ? '' : 's'} · cheapest on {cheapest.airlineName ?? cheapest.airline} at{' '}
          {departureClock(cheapest.departureAt)}
          {insights?.usualLow && insights.usualHigh
            ? ` · usual range ${formatMoney(insights.usualLow, route.currency)}–${formatMoney(insights.usualHigh, route.currency)}`
            : ''}
        </p>
      ) : (
        <p className={styles.note}>Nothing observed yet. Run a collection pass.</p>
      )}

      {/*
        A stretch of archive with no new points means either no price movement
        or no collector, and only the heartbeat count tells them apart. A series
        whose gaps are ambiguous is a series nobody should trust.
      */}
      {health ? (
        <p className={styles.note}>
          {health.checks} look{health.checks === 1 ? '' : 's'} taken, {health.changes} found a
          change
          {health.errors > 0 ? `, ${health.errors} failed` : ''}
          {health.lastCheckedAt
            ? `. Last looked at ${health.lastCheckedAt.slice(0, 16).replace('T', ' ')}.`
            : '.'}
        </p>
      ) : null}
    </div>
  );
}
