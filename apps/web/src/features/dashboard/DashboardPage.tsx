import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { formatRelativeTime } from '@/shared/lib/relativeTime';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import { useCodexResets } from './hooks/useCodexResets';
import { fetchLatestTweetRun, fetchTweets, subscribeTweets } from './data/supabaseTweets';
import { formatBogotaDateTime } from './lib/codexResetCalendar';
import { CodexResetOverview } from './ui/CodexResetOverview';
import styles from './DashboardPage.module.css';

const HANDLE = 'thsottiaux';
const exactTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

type Tweets = Awaited<ReturnType<typeof fetchTweets>>;

const AVATAR_URL = 'https://codex-resets.com/thsottiaux-avatar.jpg';

function Column({ title, tweets, now }: { title: string; tweets: Tweets; now: Date }) {
  return (
    <section className={styles.column}>
      <h2 className={styles.columnTitle}>{title}</h2>
      <div className={styles.rows}>
        {tweets.map((tweet) => (
          <article key={tweet.id} className={styles.tweet}>
            <img
              className={styles.avatar}
              src={AVATAR_URL}
              alt="@thsottiaux"
              width="44"
              height="44"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            <div className={styles.bubble}>
              <div className={styles.tweetMeta}>
                <time className={styles.when} dateTime={new Date(tweet.date).toISOString()}>
                  <strong>{formatRelativeTime(tweet.date, now)}</strong>
                  <span>{formatBogotaDateTime(tweet.date)}</span>
                </time>
              </div>
              <p>{tweet.text}</p>
              <a href={tweet.url} target="_blank" rel="noreferrer">
                Open on X
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function useLiveNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function DashboardPage() {
  const client = useQueryClient();
  const now = useLiveNow();
  const codexResets = useCodexResets();
  const query = useQuery({
    queryKey: ['tweets', HANDLE],
    queryFn: () => fetchTweets(HANDLE),
  });
  const run = useQuery({ queryKey: ['collector-runs', 'x-posts'], queryFn: fetchLatestTweetRun });
  useEffect(() => {
    return subscribeTweets(
      HANDLE,
      () => void client.invalidateQueries({ queryKey: ['tweets', HANDLE] }),
    );
  }, [client]);
  const tweets = query.data ?? [];
  const running = run.data?.status === 'running';
  const finishedAt = run.data?.completed_at ?? null;
  const relativeFinishedAt = finishedAt ? formatRelativeTime(finishedAt) : null;

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        title={`@${HANDLE}`}
        className={styles.header}
        actions={
          <span
            className={styles.updated}
            title={
              relativeFinishedAt && finishedAt ? exactTime.format(new Date(finishedAt)) : undefined
            }
          >
            {relativeFinishedAt ? `Updated ${relativeFinishedAt}` : 'Never updated'}
          </span>
        }
      />
      {running ? (
        <p className={styles.progress} role="status">
          X collector is running.
        </p>
      ) : null}
      {run.data?.status === 'failed' ? (
        <Panel role="alert">
          The X collector failed{run.data.error_code ? ` (${run.data.error_code})` : ''}.
        </Panel>
      ) : null}
      <CodexResetOverview query={codexResets} now={now} />
      {query.isLoading ? (
        <Panel>Loading tweets…</Panel>
      ) : query.isError ? (
        <Panel role="alert">Could not load captured tweets.</Panel>
      ) : tweets.length === 0 ? (
        <Panel>Nothing captured yet. Run the X scraper to populate this dashboard.</Panel>
      ) : (
        <div className={styles.columns}>
          <Column title="Posts" tweets={tweets.filter((tweet) => !tweet.isReply)} now={now} />
          <Column title="Replies" tweets={tweets.filter((tweet) => tweet.isReply)} now={now} />
        </div>
      )}
    </section>
  );
}
