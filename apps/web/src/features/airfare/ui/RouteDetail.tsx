import { formatFlightDate } from '@/features/airfare/data/fareRoutes';
import { variation } from '@/features/airfare/lib/flights';
import { departureClock, formatStamp } from '@/features/airfare/lib/series';
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
 * Two boxes of figures. The chart underneath answers "how has it moved"; this
 * answers "what is it, and should I care today" — which is the question a
 * watchlist exists for, and the one a reader should not have to read a chart
 * to get.
 *
 * The first box is money. The second is everything that used to be two
 * sentences underneath: what is on the board, and what the collector has
 * managed. They were prose because there were only two of them; laid out as
 * figures they are read at the same glance as the prices instead of after
 * them.
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
        {/*
          The departure sits beside the pair rather than in a sentence under
          it. "Departs" was doing no work: a route has one date, and it is
          written next to the two airports it belongs to.
        */}
        <h3 className={styles.pair}>
          {route.origin} <span className={styles.to}>→</span> {route.destination}{' '}
          {/* The space is deliberate: the gap beside it is a margin, and a
              margin is not something a screen reader can hear. */}
          <span className={styles.when}>{formatFlightDate(route.flightDate)}</span>
        </h3>
        <p className={styles.cities}>
          {cities.from ?? route.origin} to {cities.to ?? route.destination}
        </p>
        {health?.lastCheckedAt ? (
          <p className={styles.cities}>Last look {formatStamp(health.lastCheckedAt)}</p>
        ) : null}
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
        <dl className={`${styles.figures} ${styles.wide}`}>
          <div>
            <dt>Itineraries</dt>
            <dd>{offers.length}</dd>
          </div>
          <div>
            <dt>Airlines</dt>
            <dd>{airlines}</dd>
          </div>
          <div>
            <dt>Cheapest on</dt>
            <dd>
              {cheapest.airlineName ?? cheapest.airline} · {departureClock(cheapest.departureAt)}
            </dd>
          </div>
          <div>
            <dt>Usual range</dt>
            <dd>
              {insights?.usualLow && insights.usualHigh
                ? `${formatMoney(insights.usualLow, route.currency)}–${formatMoney(insights.usualHigh, route.currency)}`
                : NO_VALUE}
            </dd>
          </div>
          {/*
            A stretch of archive with no new points means either no price
            movement or no collector, and only the heartbeat count tells them
            apart. A series whose gaps are ambiguous is a series nobody should
            trust — so the looks taken are a figure here, not a footnote.
          */}
          <div>
            <dt>Looks taken</dt>
            <dd>{health ? health.checks : NO_VALUE}</dd>
          </div>
          <div>
            <dt>Changes</dt>
            <dd>{health ? health.changes : NO_VALUE}</dd>
          </div>
          {health && health.errors > 0 ? (
            <div>
              <dt>Failed</dt>
              <dd className={styles.dear}>{health.errors}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className={`${styles.note} ${styles.wide}`}>
          Nothing observed yet. Run a collection pass.
        </p>
      )}
    </div>
  );
}
