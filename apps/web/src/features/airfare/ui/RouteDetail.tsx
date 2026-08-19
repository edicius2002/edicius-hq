import {
  focusDeparted,
  formatFlightDate,
  formatReading,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { variation } from '@/features/airfare/lib/flights';
import { departureClock, formatStamp } from '@/features/airfare/lib/series';
import type { FareInsights, FareSnapshot, WatchHealth } from '@/shared/api/fares';
import { formatMoney, NO_VALUE } from '@/shared/lib/money';
import { Button } from '@/shared/ui/Button';

import styles from './RouteDetail.module.css';

type RouteDetailProps = {
  route: FareRoute | null;
  latest: FareSnapshot | null;
  insights: FareInsights | null;
  health: WatchHealth | null;
  cities: { from: string | null; to: string | null };
  /** Today, `YYYY-MM-DD`. Only used to say whether the focused day has gone. */
  today: string;
  /** Drop this route's focus and go back to reading the whole month. */
  onClearFocus: () => void;
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
 * Under a focus date the set it reduces has one day in it, because the page
 * narrowed it with `readingPrefix` before it got here — 12.131. So the same
 * reduction gives "the cheapest day in March" and "the 9th of March", and this
 * component does not have to know which question it is answering. What it does
 * have to do is name the right one in the heading, which is why `route` is the
 * whole route rather than a month.
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
  latest,
  insights,
  health,
  cities,
  today,
  onClearFocus,
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

          With a focus date this becomes that day, `dd/mm/yyyy` — 12.130 — and
          it is not only the heading that moves: the figures under it, the
          chart and the flight table are all narrowed to the same departure by
          `readingPrefix`. A heading naming a day over a month of numbers would
          be worse than either.
        */}
        <h3 className={styles.pair}>
          {route.origin} <span className={styles.to}>→</span> {route.destination}{' '}
          {/* The space is deliberate: the gap beside it is a margin, and a
              margin is not something a screen reader can hear. */}
          <span className={styles.when}>{formatReading(route)}</span>
        </h3>
        <p className={styles.cities}>
          {cities.from ?? route.origin} to {cities.to ?? route.destination}
        </p>
        {/*
          A focused day that has already gone, said rather than left to be
          worked out — 12.133. It is not dropped when it passes: the archive it
          points at is still the archive of the flight the reader meant to
          take, and a stored value that vanished because the page was opened a
          day later would be a document editing itself. But every figure below
          is then frozen at the last look before departure, and a panel that
          did not say so would read as a live price.

          The way back to the month is beside it and not only when the day has
          gone, because a focus changes the whole panel and a state that cannot
          be undone without deleting the route is a trap. It only clears the
          focus; nothing collected is touched.
        */}
        {route.focusDate ? (
          <p className={styles.cities}>
            {focusDeparted(route, today) ? (
              <span className={styles.dear}>That day has departed. </span>
            ) : null}
            <Button variant="ghost" size="small" onClick={onClearFocus}>
              Read the whole month
            </Button>
          </p>
        ) : null}
        {/*
          Which of the month's departures the figures below belong to, written
          `dd/mm/yyyy` like every other real date here — the month in the
          heading is spelled out precisely so these two can never be read as
          the same kind of thing. It is a line rather than a fifth figure
          because the figures box is measured to four across.

          Absent under a focus, where the heading already names the only
          departure there is: the same date twice, three lines apart, reads as
          two facts that happen to agree rather than as one.
        */}
        {latest && !route.focusDate ? (
          <p className={styles.cities}>Cheapest on {formatFlightDate(latest.flightDate)}</p>
        ) : null}
        {health?.lastCheckedAt ? (
          <p className={styles.cities}>Last look {formatStamp(health.lastCheckedAt)}</p>
        ) : null}
      </header>

      <dl className={styles.figures}>
        <div>
          {/*
            Still four figures in this box, and deliberately: the widths here
            were measured against a 736px row at 8rem a column, and a fifth
            would put one of them on a line of its own. Which day the price
            belongs to goes in the header instead, where there is a column of
            room and no arithmetic.
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
