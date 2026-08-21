import { describeKinds, formatReset, spendMarks } from '@/features/airfare/lib/spendReading';
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
 * **Nothing here draws a percentage, and that is the whole design of the
 * track.** 600 is a judgement: `config.py` says outright that the real limit is
 * how much traffic this address can send before Google stops answering, that it
 * is unknown, and that probing it costs the thing it protects. So a gauge
 * reading "23% used" would be inventing a safe maximum, and a fill that turned
 * amber and then red would be inventing thresholds inside it. What is drawn
 * instead is counts, one flat accent at every level, and a mark on the track at
 * **329** — the busiest day this address has ever actually sent, measured — with
 * the sentence underneath saying which of the two numbers was measured and which
 * was chosen.
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
   * The collector fails closed on this: an unreadable day is treated as fully
   * spent, every departure comes back `over-budget`, and nothing will collect
   * until it can be read. So this branch is an alarm rather than a gap, printed
   * in the colour the watchlist prints a refusal in — and with no track at all,
   * because the only two lengths a bar could take here are "none" and "all" and
   * both would be a claim the words are explicitly declining to make.
   */
  if (spend.spent === null) {
    return (
      <div className={styles.strip} data-testid="spend-today">
        <p className={styles.head}>
          <span className={styles.label}>Requests today</span>
          <span className={styles.unknown}>unknown</span>
        </p>
        <p className={`${styles.note} ${styles.refused}`}>
          Today&rsquo;s ledger cannot be read, so every pass refuses until it can.
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
   */
  const facts = [
    spend.spent === 0 ? 'Nothing sent yet today' : `${spend.remaining} left`,
    kinds,
    resets === null ? null : `resets ${resets}`,
  ].filter((part): part is string => part !== null);

  return (
    <div className={styles.strip} data-testid="spend-today">
      <p className={styles.head}>
        <span className={styles.label}>Requests today</span>
        <span className={styles.figure}>{spend.spent}</span>
        <span className={styles.of}>of {spend.ceiling}</span>
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
        The sentence that stops the track being a gauge. It names which number
        was measured and which was chosen, in that order, because the measured
        one is the only one a reader can safely reason from.
      */}
      <p className={styles.caveat}>
        {spend.busiestOnRecord} is the busiest day on record; {spend.ceiling} is a ceiling we chose,
        not a limit anyone has measured.
      </p>
    </div>
  );
}
