import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { formatRelativeTime } from '@/shared/lib/relativeTime';
import { Button } from '@/shared/ui/Button';
import { Panel } from '@/shared/ui/Panel';

import { useCodexResets } from './hooks/useCodexResets';
import { fetchTweets, subscribeTweets, TWEET_WINDOW_MS } from './data/supabaseTweets';
import { formatBogotaDateTime } from './lib/codexResetCalendar';
import { UsdPenGadget } from './fx/UsdPenGadget';
import { CodexResetOverview } from './ui/CodexResetOverview';
import { ZoneClock } from './ui/ZoneClock';
import styles from './DashboardPage.module.css';

const HANDLE = 'thsottiaux';

type Tweets = Awaited<ReturnType<typeof fetchTweets>>;

const AVATAR_URL = 'https://codex-resets.com/thsottiaux-avatar.jpg';

function Column({ title, tweets, now }: { title: string; tweets: Tweets; now: Date }) {
  return (
    <section className={styles.column}>
      <h2 className={styles.columnTitle}>{title}</h2>
      <div className={styles.rows}>
        {tweets.length === 0 ? (
          <p className={styles.emptyColumn}>No {title.toLowerCase()} in the last 48 hours.</p>
        ) : null}
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
  useEffect(() => {
    return subscribeTweets(
      HANDLE,
      () => void client.invalidateQueries({ queryKey: ['tweets', HANDLE] }),
    );
  }, [client]);
  const cutoff = now.getTime() - TWEET_WINDOW_MS;
  const tweets = (query.data ?? []).filter((tweet) => new Date(tweet.date).getTime() >= cutoff);

  return (
    <section className={styles.page} aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className={styles.srOnly}>
        Dashboard
      </h1>
      <div className={styles.titleRow}>
        <ZoneClock label="PST" timeZone="Etc/GMT+8" />
        <ZoneClock label="PT" timeZone="America/Los_Angeles" />
        <ZoneClock label="PER" timeZone="America/Lima" />
        <ZoneClock label="EST" timeZone="America/New_York" />
        <ZoneClock label="ARG" timeZone="America/Argentina/Buenos_Aires" />
      </div>
      <div className={styles.overview}>
        <CodexResetOverview query={codexResets} now={now} />
        <UsdPenGadget now={now} />
      </div>
      <h2 className={styles.postsHeading}>@{HANDLE}</h2>
      {query.isError && query.data !== undefined ? (
        <Panel className={styles.statusPanel} role="alert">
          Could not refresh captured tweets. Showing the last available posts.
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Panel>
      ) : null}
      {query.isLoading ? (
        <Panel className={styles.statusPanel}>Loading tweets…</Panel>
      ) : query.isError && query.data === undefined ? (
        <Panel className={styles.statusPanel} role="alert">
          Could not load captured tweets.
        </Panel>
      ) : tweets.length === 0 ? (
        <Panel className={styles.statusPanel}>No posts in the last 48 hours.</Panel>
      ) : (
        <div className={styles.columns}>
          <Column title="Posts" tweets={tweets.filter((tweet) => !tweet.isReply)} now={now} />
          <Column title="Replies" tweets={tweets.filter((tweet) => tweet.isReply)} now={now} />
        </div>
      )}
    </section>
  );
}
