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
  const loading = !data && query.isPending;
  const latest = data?.latestReset;
  return (
    <div className={styles.overview} aria-busy={loading}>
      <section className={styles.hero} aria-labelledby="latest-reset-title">
        <h2 id="latest-reset-title">Latest Codex limit reset</h2>
        {loading ? (
          <>
            <span
              className={`${styles.placeholder} ${styles.heroPlaceholder}`}
              aria-hidden="true"
            />
            <span
              className={`${styles.placeholder} ${styles.datePlaceholder}`}
              aria-hidden="true"
            />
            <span
              className={`${styles.placeholder} ${styles.typePlaceholder}`}
              aria-hidden="true"
            />
          </>
        ) : latest ? (
          <>
            <strong className={styles.relative}>
              {formatRelativeTime(latest.announcedAt, now)}
            </strong>
            <time dateTime={latest.announcedAt}>{formatBogotaDateTime(latest.announcedAt)}</time>
            <span className={styles.type}>{latest.resetType} reset</span>
          </>
        ) : (
          <strong className={styles.noReset}>
            {data ? 'No confirmed reset yet' : 'Unavailable'}
          </strong>
        )}
      </section>
      <dl className={styles.stats}>
        <div>
          <dt>Resets</dt>
          <dd>
            {data ? (
              data.stats.total
            ) : loading ? (
              <span className={styles.placeholder} aria-hidden="true" />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Avg. miracle interval</dt>
          <dd>
            {data ? (
              days(data.stats.avgIntervalDays)
            ) : loading ? (
              <span className={styles.placeholder} aria-hidden="true" />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Longest wait</dt>
          <dd>
            {data ? (
              days(data.stats.longestIntervalDays)
            ) : loading ? (
              <span className={styles.placeholder} aria-hidden="true" />
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      <ResetCalendar
        resets={data?.resets ?? []}
        now={now}
        loading={loading}
        unavailable={!data && !loading}
      />
    </div>
  );
}
