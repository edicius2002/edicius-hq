import {
  describeKinds,
  describeRemaining,
  formatReset,
  spendMarks,
} from '@/features/airfare/lib/spendReading';
import type { FareSpend } from '@/shared/api/fares';

import styles from './SpendToday.module.css';

type SpendTodayProps = {
  /** Today's ledger, or undefined while it has not arrived or could not be fetched. */
  spend: FareSpend | undefined;
  /** The query has not answered yet. Nothing is drawn — see below. */
  loading: boolean;
};

/**
 * What this address has already sent today, in the page header.
 *
 * **This is a fact about us, and that is why it is here rather than anywhere
 * else on the page.** Every other number on this page is a fare or a fact about
 * one, and the two kinds must not be filed together: the analysis panel and the
 * detail strip answer "what does this route cost", the watchlist's rows answer
 * "what did the last press on this route do", and a figure about our own
 * spending sitting in either would read as belonging to a route. It belongs to
 * the machine. The header is the one part of this page that is about the page,
 * and it has held a title and nothing else since the page-wide collect button
 * was withdrawn — so the strip costs about forty pixels of a page several
 * thousand tall, and it is the first thing on it.
 *
 * The alternative that was actually close was the foot of the watchlist panel,
 * where the argument is real: that list's order *is* the budget's priority
 * order — dragging a route to the top says "poll this one first when there is
 * not enough for everything". It loses on height. That panel shares a row with
 * the map, its rows scroll inside whatever is left, and a footer of this size
 * takes about four routes off the visible list — the very trade
 * `a-taller-row-is-four-more-routes` was measured to avoid.
 *
 * **Nothing here draws a percentage, and that argument has now taken the track
 * with it.** The ceiling was a judgement — `config.py` said outright that the
 * real limit is how much traffic this address can send before Google stops
 * answering, that it is unknown, and that probing it costs the thing it
 * protects — so a gauge reading "23% used" would have been inventing a safe
 * maximum. The number is gone rather than the caveat: no ceiling is configured
 * by default, and what is left to draw is a count.
 *
 * So on an ordinary day this is words and no track at all. A bar needs an end,
 * and the one number that could pretend to be one is **329**, the busiest day
 * this address has ever actually sent — which is a high-water mark, and filling
 * a bar towards it would make the strip's only measured fact into exactly the
 * invented maximum the ceiling stopped being. It is printed as a sentence
 * instead, which is the form a fact of that shape can be read honestly in.
 *
 * The track is still here and still drawn where an environment sets
 * `FARES_DAILY_REQUEST_BUDGET`: a real ceiling, a fill against it, one flat
 * accent at every level and 329 marked on it. That is the arrangement this
 * strip was built with, and it was right about everything except whether the
 * ceiling it drew against should exist.
 */
export function SpendToday({ spend, loading }: SpendTodayProps) {
  /*
   * Nothing at all until there is something true to say — 12.234, and the same
   * rule `.report` follows in the watchlist. A placeholder figure is a claim
   * about the collector, and the one moment this readout must not be trusted is
   * the moment before it has read anything.
   */
  if (loading && !spend) return null;

  if (!spend) {
    return (
      <div className={styles.strip} data-testid="spend-today">
        <p className={styles.head}>
          <span className={styles.label}>Requests today</span>
        </p>
        {/*
          Our own API not answering, which is a different fault from the ledger
          being unreadable and must not be dressed as one: nothing is known
          about the collector here, whereas below the collector is known to have
          stopped.
        */}
        <p className={styles.note}>Today&rsquo;s spend is unavailable.</p>
      </div>
    );
  }

  const resets = formatReset(spend.resetsAt);

  /*
   * A ledger that cannot be read, which is not a quiet day.
   *
   * Two different faults share this branch and the sentence has to say which.
   * Under a ceiling the collector fails closed: an unreadable day is treated as
   * fully spent, every departure comes back `over-budget`, and nothing will
   * collect until the file can be read. With no ceiling there is nothing to
   * fail closed against — collection carries on and what is lost is the record
   * of it, which is a smaller alarm and still not a quiet morning.
   *
   * No track either way, because the only two lengths a bar could take here are
   * "none" and "all" and both would be a claim the words are explicitly
   * declining to make.
   */
  if (spend.spent === null) {
    return (
      <div className={styles.strip} data-testid="spend-today">
        <p className={styles.head}>
          <span className={styles.label}>Requests today</span>
          <span className={styles.unknown}>unknown</span>
        </p>
        <p className={`${styles.note} ${styles.refused}`}>
          {spend.ceiling === null
            ? 'Today’s ledger cannot be read, so passes collect unrecorded.'
            : 'Today’s ledger cannot be read, so every pass refuses until it can.'}
        </p>
      </div>
    );
  }

  const marks = spendMarks(spend.spent, spend.ceiling, spend.busiestOnRecord);
  const kinds = describeKinds(spend.kinds);

  /*
   * A day with nothing on it says so in words rather than repeating itself.
   *
   * "0 of 600" and "600 left" are the same sentence twice, and a day with no
   * file yet and a day whose file is empty are the same fact — the server
   * answers zero for both, deliberately, because a day nobody has collected on
   * *is* a file that does not exist yet.
   *
   * With no ceiling there is no "left" to report at all: what is left of an
   * unbounded day is not a number, and the only wrong thing this line could do
   * is invent one. A quiet day still says so, because "nothing sent yet" is a
   * fact about the collector rather than about an allowance.
   */
  const left = spend.spent === 0 ? 'Nothing sent yet today' : describeRemaining(spend.remaining);
  const facts = [left, kinds, resets === null ? null : `resets ${resets}`].filter(
    (part): part is string => part !== null,
  );

  return (
    <div className={styles.strip} data-testid="spend-today">
      <p className={styles.head}>
        <span className={styles.label}>Requests today</span>
        <span className={styles.figure}>{spend.spent}</span>
        {spend.ceiling === null ? null : <span className={styles.of}>of {spend.ceiling}</span>}
      </p>

      {/*
        `aria-hidden`, with no `progressbar` role and no figures on it — the
        watchlist settled this question the same way. Every number the track
        draws is already in the two lines around it, and a bar carrying them
        again would make a screen reader hear the day's spend twice.
      */}
      {marks ? (
        <span className={styles.track} data-testid="spend-track" aria-hidden="true">
          <span className={styles.fill} style={{ width: `${marks.fill * 100}%` }} />
          {marks.busiest === null ? null : (
            <span
              className={styles.busiest}
              data-testid="spend-busiest"
              style={{ left: `${marks.busiest * 100}%` }}
            />
          )}
        </span>
      ) : null}

      <p className={styles.note}>{facts.join(' · ')}</p>
      {/*
        The sentence that stops the figure above being read as a fraction of
        something. It leads with the measured number in both forms, because that
        is the only one a reader can safely reason from — and where there is no
        ceiling it is the only one there is, which is precisely when a reader is
        most likely to supply an imaginary one.
      */}
      <p className={styles.caveat}>
        {spend.ceiling === null ? (
          <>
            {spend.busiestOnRecord} is the busiest day on record; nothing caps the day, so the pace
            is what holds it.
          </>
        ) : (
          <>
            {spend.busiestOnRecord} is the busiest day on record; {spend.ceiling} is a ceiling we
            chose, not a limit anyone has measured.
          </>
        )}
      </p>
    </div>
  );
}
