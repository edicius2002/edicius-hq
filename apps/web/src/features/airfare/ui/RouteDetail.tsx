import {
  formatFlightDate,
  formatFlightMonth,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { variation } from '@/features/airfare/lib/flights';
import { departureClock, formatInstant } from '@/features/airfare/lib/series';
import type { FareInsights, FareSnapshot, WatchHealth } from '@/shared/api/fares';
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
          Which of the month's departures the figures below belong to, written
          `dd/mm/yyyy` like every other real date here — the month in the
          heading is spelled out precisely so these two can never be read as
          the same kind of thing. It is a line here rather than a fifth figure
          because the box beside it holds money and a date is not money.

          Unconditional again: it used to be hidden under a focus, where the
          heading already named the only departure there was.
        */}
        {latest ? (
          <p className={styles.cities}>Cheapest on {formatFlightDate(latest.flightDate)}</p>
        ) : null}
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
            header, with the other facts about the route.
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
      ) : loading ? (
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
