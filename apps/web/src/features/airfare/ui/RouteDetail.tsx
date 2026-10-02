import { formatFlightMonth, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { variation } from '@/features/airfare/lib/flights';
import { formatInstant } from '@/features/airfare/lib/series';
import type { FareInsights, FareOffer, FareSnapshot, WatchHealth } from '@/shared/api/fares';
import { formatMoney, NO_VALUE } from '@/shared/lib/money';
import { Skeleton } from '@/shared/ui/Skeleton';

import styles from './RouteDetail.module.css';

type RouteDetailProps = {
  route: FareRoute | null;
  /** Which of the route's months is being read. The figures are all of it. */
  month: string | null;
  latest: FareSnapshot | null;
  insights: FareInsights | null;
  health: WatchHealth | null;
  cities: { from: string | null; to: string | null };
  /** A new route's archive can be pending even though its data is absent. */
  loading?: boolean;
};

/**
 * The provider's departure is airport wall clock without a zone. Parse only
 * its calendar date, then use UTC weekday arithmetic so the browser's zone
 * cannot turn an early departure into the previous day.
 */
function cheapestDay(departureAt: string): string {
  const [year, month, day] = departureAt.slice(0, 10).split('-').map(Number);
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  ];
  return `${weekday} · ${String(day).padStart(2, '0')}`;
}

/** Keep both markers inside the painted track, including outlying offers. */
function rangePosition(value: number, low: number, high: number): string {
  return `${Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100))}%`;
}

/** A monthly price board, the provider's usual range, and the chosen departure. */
export function RouteDetail({
  route,
  month,
  latest,
  insights,
  health,
  cities,
  loading = false,
}: RouteDetailProps) {
  if (!route) {
    return (
      <div className={styles.detail}>
        <p className={styles.empty}>Add a route to start building its history.</p>
      </div>
    );
  }

  const pricedOffers = (latest?.offers ?? []).filter(
    (offer): offer is FareOffer & { price: number } =>
      offer.price !== null && Number.isFinite(offer.price),
  );
  const cheapest = pricedOffers.length
    ? pricedOffers.reduce((a, b) => (a.price <= b.price ? a : b))
    : null;
  const typical = insights?.typical ?? null;
  const vsUsual = cheapest && typical ? variation(typical, cheapest.price) : null;
  const tone =
    vsUsual === null ? 'neutral' : vsUsual <= -8 ? 'cheap' : vsUsual >= 8 ? 'dear' : 'neutral';
  const low = insights?.usualLow ?? null;
  const high = insights?.usualHigh ?? null;
  const hasRange = low !== null && high !== null && high > low;
  const isSkeleton = loading && !latest;

  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        <h3 className={styles.pair}>
          {route.origin} <span className={styles.to}>→</span> {route.destination}{' '}
          {/* A text space matters to screen readers; CSS margin alone does not. */}
          <span className={styles.when}>{month ? formatFlightMonth(month) : ''}</span>
        </h3>
        <p className={styles.cities}>
          {cities.from ?? route.origin} to {cities.to ?? route.destination}
        </p>
      </header>

      {isSkeleton ? (
        <div className={styles.body} role="status">
          <span className={styles.visuallyHidden}>Loading fares</span>
          <div className={styles.hero}>
            <Skeleton width="40%" height={11} />
            <div className={styles.priceLine}>
              <Skeleton className={styles.priceSkeleton} height={34} />
              <div className={styles.meta}>
                <Skeleton width="100%" height={19} radius={99} />
                <Skeleton width="80%" height={13} />
              </div>
            </div>
          </div>
          <div className={styles.range}>
            <Skeleton width="100%" height={56} />
            <Skeleton width="100%" height={18} />
          </div>
          <div className={styles.tiles}>
            <Skeleton className={styles.tileSkeleton} width="100%" radius={9} />
            <Skeleton className={styles.tileSkeleton} width="100%" radius={9} />
          </div>
          <footer className={styles.footer}>
            <Skeleton width="70%" height={12} />
          </footer>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.hero}>
            <span className={styles.label}>Cheapest now</span>
            <div className={styles.priceLine}>
              <strong className={styles.price}>
                {cheapest ? formatMoney(cheapest.price, route.currency) : NO_VALUE}
              </strong>
              <div className={styles.meta}>
                <span className={`${styles.chip} ${styles[tone]}`}>
                  {vsUsual === null
                    ? NO_VALUE
                    : `${vsUsual > 0 ? '+' : ''}${vsUsual.toFixed(1)}% vs usual`}
                </span>
                <span className={styles.airline}>
                  {cheapest ? (
                    <>
                      on <b>{cheapest.airlineName ?? cheapest.airline}</b>
                    </>
                  ) : (
                    '\u00a0'
                  )}
                </span>
              </div>
            </div>
          </div>

          <div className={styles.range}>
            <div className={styles.track}>
              {!cheapest && !loading ? (
                <p className={styles.emptyNote}>Nothing observed yet. Run a collection pass.</p>
              ) : null}
              {hasRange ? (
                <>
                  <div className={styles.bar} />
                  {typical !== null && (
                    <>
                      <span
                        className={styles.usualLabel}
                        style={{ left: rangePosition(typical, low, high) }}
                      >
                        usual
                      </span>
                      <span
                        className={styles.tick}
                        data-range-marker
                        style={{ left: rangePosition(typical, low, high) }}
                      />
                    </>
                  )}
                  {cheapest && (
                    <>
                      <span
                        className={styles.dot}
                        data-range-marker
                        style={{ left: rangePosition(cheapest.price, low, high) }}
                      />
                      <span
                        className={styles.nowLabel}
                        style={{ left: rangePosition(cheapest.price, low, high) }}
                      >
                        now
                      </span>
                    </>
                  )}
                </>
              ) : null}
            </div>
            <div className={styles.ends}>
              <span>{hasRange ? formatMoney(low, route.currency) : NO_VALUE}</span>
              <span>{hasRange ? formatMoney(high, route.currency) : NO_VALUE}</span>
            </div>
          </div>

          <div className={styles.tiles}>
            <div className={styles.tile} data-detail-tile>
              <span className={styles.label}>Usually</span>
              <strong className={styles.tileValue}>
                {typical !== null ? formatMoney(typical, route.currency) : NO_VALUE}
              </strong>
            </div>
            <div className={styles.tile} data-detail-tile>
              <span className={styles.label}>Cheapest day</span>
              <strong className={styles.tileValue}>
                {cheapest ? cheapestDay(cheapest.departureAt) : NO_VALUE}
              </strong>
            </div>
          </div>

          <footer className={styles.footer}>
            {health?.lastCheckedAt ? `Last look ${formatInstant(health.lastCheckedAt)}` : null}
          </footer>
        </div>
      )}
    </div>
  );
}
