import type { UseQueryResult } from '@tanstack/react-query';

import type { CodexResetsResponse } from '@/shared/api/codexResets';
import { formatRelativeTime } from '@/shared/lib/relativeTime';

import { formatBogotaDateTime } from '../lib/codexResetCalendar';
import { ResetCalendar } from './ResetCalendar';
import styles from './CodexResetOverview.module.css';

function days(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}d`;
}

export function CodexResetOverview({
  query,
  now,
}: {
  query: UseQueryResult<CodexResetsResponse, Error>;
  now: Date;
}) {
  const data = query.data;
  if (!data && query.isPending) {
    return (
      <div className={styles.loading} role="status">
        Loading Codex reset history…
      </div>
    );
  }
  if (!data) {
    return (
      <div className={styles.error} role="alert" aria-label="Codex reset data">
        <strong>Codex reset data could not refresh.</strong>
        <span>Posts and replies remain available below.</span>
      </div>
    );
  }

  const stale = data.stale || query.isError;
  const latest = data.latestReset;
  return (
    <div className={styles.overview}>
      {stale ? (
        <p className={styles.stale} role="status" aria-label="Codex reset data">
          Could not refresh; showing cached data fetched {formatBogotaDateTime(data.fetchedAt)}.
        </p>
      ) : null}
      <section className={styles.hero} aria-labelledby="latest-reset-title">
        <h2 id="latest-reset-title">Latest Codex limit reset</h2>
        {latest ? (
          <>
            <strong className={styles.relative}>
              {formatRelativeTime(latest.announcedAt, now)}
            </strong>
            <time dateTime={latest.announcedAt}>{formatBogotaDateTime(latest.announcedAt)}</time>
            <span className={styles.type}>{latest.resetType} reset</span>
          </>
        ) : (
          <strong className={styles.noReset}>No confirmed reset yet</strong>
        )}
      </section>
      <dl className={styles.stats}>
        <div>
          <dt>Resets</dt>
          <dd>{data.stats.total}</dd>
        </div>
        <div>
          <dt>Avg. miracle interval</dt>
          <dd>{days(data.stats.avgIntervalDays)}</dd>
        </div>
        <div>
          <dt>Longest wait</dt>
          <dd>{days(data.stats.longestIntervalDays)}</dd>
        </div>
      </dl>
      <ResetCalendar resets={data.resets} now={now} />
      <p className={styles.attribution}>
        Data by{' '}
        <a href="https://codex-resets.com/" target="_blank" rel="noreferrer">
          Codex Resets
        </a>{' '}
        from @thsottiaux announcements. Independent tracker; not affiliated with OpenAI.
      </p>
    </div>
  );
}
