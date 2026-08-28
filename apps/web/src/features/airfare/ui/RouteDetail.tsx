import { formatFlightMonth, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { variation } from '@/features/airfare/lib/flights';
import { departureClock, formatInstant } from '@/features/airfare/lib/series';
import type { FareInsights, FareOffer, FareSnapshot, WatchHealth } from '@/shared/api/fares';
import { formatMoney, NO_VALUE } from '@/shared/lib/money';

import styles from './RouteDetail.module.css';

type RouteDetailProps = {
  route: FareRoute | null;
  /** Which of the route's months is being read. The figures are all of it. */
  month: string | null;
  latest: FareSnapshot | null;
  insights: FareInsights | null;
  health: WatchHealth | null;
  cities: { from: string | null; to: string | null };
  /**
   * Whether this route's archive is still being fetched.
   *
   * Every other prop here is derived from `useFareHistory`'s `data`, and a
   * query whose key has changed has no data — so without this the panel cannot
   * tell "this route has nothing collected" from "we have not been told yet",
   * and says the first about the second. See `a-fetch-is-not-an-empty-archive`.
   */
  loading?: boolean;
};

/**
 * What this route costs right now, and whether that is a lot.
 *
 * `latest` is the **cheapest departure in whatever is being read**, as that day
 * was last seen — see `cheapestDeparture`. Since 12.110 the panel describes a
 * month rather than a day, and the honest single board to put in front of the
 * reader is the one they would actually book: the newest snapshot of all would
 * belong to whichever departure the collector happened to reach last, which is
 * a fact about pacing rather than about fares.
 *
 * There is one question again, and it is the month's — 12.260. This panel
 * briefly answered two, because a watch could name one departure inside its
 * month and the page narrowed onto it; the heading, the "cheapest on" line and
 * the way back out of it were all that arrangement's. `route` is still the
 * whole route rather than a month, because the heading names the pair as well.
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
    return <p className={styles.empty}>Add a route to start building its history.</p>;
  }

  const offers = latest?.offers ?? [];
  const pricedOffers = offers.filter(
    (offer): offer is FareOffer & { price: number } =>
      offer.price !== null && Number.isFinite(offer.price),
  );
  const cheapest = pricedOffers.length
    ? pricedOffers.reduce((a, b) => (a.price <= b.price ? a : b))
    : null;
  const dearest = pricedOffers.length
    ? pricedOffers.reduce((a, b) => (a.price >= b.price ? a : b))
    : null;
  const typical = insights?.typical ?? null;
  const vsUsual = cheapest && typical ? variation(typical, cheapest.price) : null;
  const airlines = new Set(offers.map((offer) => offer.airline)).size;
  const tone =
    vsUsual === null ? 'neutral' : vsUsual <= -8 ? 'cheap' : vsUsual >= 8 ? 'dear' : 'neutral';

  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        {/*
          The departures sit beside the pair rather than in a sentence under
          it. "Departs" was doing no work: a route has one month, and it is
          written next to the two airports it belongs to. A month name rather
          than `03/2027` — 12.114 — so nothing on this page reads as a day that
          is not one.

          Always a month, since 12.260 took the focus away. It briefly became
          the focused day where there was one, and with it went the figures
          under it, the chart and the flight table.

          *Which* month is the tab the reader has open, handed down rather than
          taken off the route: a watch holds several and the figures under this
          heading are one month's, so the two have to come from one value.
        */}
        <h3 className={styles.pair}>
          {route.origin} <span className={styles.to}>→</span> {route.destination}{' '}
          {/* The space is deliberate: the gap beside it is a margin, and a
              margin is not something a screen reader can hear. */}
          <span className={styles.when}>{month ? formatFlightMonth(month) : ''}</span>
        </h3>
        <p className={styles.cities}>
          {cities.from ?? route.origin} to {cities.to ?? route.destination}
        </p>
        {/*
          "Read the whole month" stood here, and it existed only to clear a
          focus — 12.182. With the focus gone (12.260) the whole month is the
          only thing this panel ever reads, so there is no state to be let out
          of and no control to let anyone out of it.
        */}
        {/*
          The board date belongs with the board figures below rather than this
          header. `.wide` already reserves its second line for a value that
          folds, so it can hold this short date without making the strip taller;
          keeping it here would make this header reserve a fourth line all the
          time for a fact that only exists with a board.
        */}
        {health?.lastCheckedAt ? (
          <p className={styles.cities}>Last look {formatInstant(health.lastCheckedAt)}</p>
        ) : null}
      </header>

      <dl className={styles.figures}>
        <div>
          {/*
            Four figures in this box, and all four are money. The reason used
            to be a width — the row was measured at 8rem a column and a fifth
            would have fallen onto a line of its own — and since
            `a-figure-takes-what-it-holds` it is not, because a figure now
            takes the room it needs and a fifth would simply fit. What is left
            is the better reason: this box answers "what does it cost", and
            which day the price belongs to is not a price. It goes in the
            board box below, with the other facts about that board.
          */}
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
        {/*
          The board's four figures join the money's four in one row, rather
          than standing in a box of their own under it. Conditional inside the
          list rather than around it: the money is known from the moment there
          is a route and the board is not, so the row exists either way and
          simply carries fewer figures until an archive answers.
        */}
        {cheapest && latest ? (
          <>
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
              {/*
              The whole name, never an abbreviation of it: `Aerolineas
              Argentinas · 14:35` is what this figure says, and if the box is
              too narrow to hold it on one line it folds between the two words
              rather than losing either. The separator and the clock are one
              span so they cannot be parted at a line end.
            */}
              <dd>
                {cheapest.airlineName ?? cheapest.airline}{' '}
                <span className={styles.clock}>· {departureClock(cheapest.departureAt)}</span>
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
          </>
        ) : null}
      </dl>

      {cheapest && latest ? null : loading ? (
        /*
          Not "nothing observed yet" — `a-fetch-is-not-an-empty-archive`.
          Every figure above is derived from one query's `data`, and react-query
          has none for a key it has not answered yet, so choosing a route the
          reader has already collected drew a full "Nothing observed yet. Run a
          collection pass." for the length of the request. That is a fact about
          our fetch printed as a fact about their route, which is the same
          mistake 12.237 caught in the booking-horizon chart.
        */
        <p className={`${styles.note} ${styles.wide}`}>Reading the archive…</p>
      ) : (
        <p className={`${styles.note} ${styles.wide}`}>
          Nothing observed yet. Run a collection pass.
        </p>
      )}
    </div>
  );
}
