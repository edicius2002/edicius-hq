import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { formatRelativeTime } from '@/shared/lib/relativeTime';
import { Button } from '@/shared/ui/Button';
import { Panel } from '@/shared/ui/Panel';
import { Skeleton } from '@/shared/ui/Skeleton';

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

function Column({
  title,
  tweets,
  now,
  enteringIds,
  onEntered,
}: {
  title: string;
  tweets: Tweets;
  now: Date;
  enteringIds: ReadonlySet<string>;
  onEntered: (id: string) => void;
}) {
  return (
    <section className={styles.column}>
      <h2 className={styles.columnTitle}>{title}</h2>
      <div className={styles.rows}>
        {tweets.length === 0 ? (
          <p className={styles.emptyColumn}>No {title.toLowerCase()} in the last 48 hours.</p>
        ) : null}
        {tweets.map((tweet) => (
          <div
            key={tweet.id}
            className={`${styles.tweetSlot} ${enteringIds.has(tweet.id) ? styles.tweetSlotEntering : ''}`}
          >
            <article
              className={`${styles.tweet} ${enteringIds.has(tweet.id) ? styles.tweetEntering : ''}`}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) onEntered(tweet.id);
              }}
            >
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
          </div>
        ))}
      </div>
    </section>
  );
}

function PostColumnsSkeleton() {
  return (
    <div className={styles.columns} role="status" aria-label="Loading posts">
      {['Posts', 'Replies'].map((title) => (
        <section className={styles.column} key={title}>
          <h2 className={styles.columnTitle}>{title}</h2>
          <div className={styles.rows}>
            {[0, 1, 2].map((index) => (
              <div className={styles.tweet} data-testid="post-skeleton-row" key={index}>
                <Skeleton width="2.2rem" height="2.2rem" radius="50%" />
                <div className={styles.bubble} style={{ width: '100%' }}>
                  <Skeleton width="45%" height={11} />
                  <Skeleton width="92%" height={12} />
                  <Skeleton width="68%" height={12} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
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
  const seenTweetIds = useRef<Set<string> | null>(null);
  const entryTimers = useRef(new Map<string, number>());
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
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
  useLayoutEffect(() => {
    if (query.data === undefined) return;
    const ids = new Set(query.data.map((tweet) => tweet.id));
    if (seenTweetIds.current !== null) {
      const added = [...ids].filter((id) => !seenTweetIds.current?.has(id));
      if (added.length > 0) {
        setEnteringIds((current) => new Set([...current, ...added]));
      }
    }
    seenTweetIds.current = ids;
  }, [query.data]);
  useEffect(() => {
    const timers = entryTimers.current;
    for (const [id, timer] of timers) {
      if (enteringIds.has(id)) continue;
      window.clearTimeout(timer);
      timers.delete(id);
    }
    for (const id of enteringIds) {
      if (timers.has(id)) continue;
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id);
          setEnteringIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }, 600),
      );
    }
  }, [enteringIds]);
  useEffect(() => {
    const timers = entryTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const onEntered = (id: string) => {
    setEnteringIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
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
        <PostColumnsSkeleton />
      ) : query.isError && query.data === undefined ? (
        <Panel className={styles.statusPanel} role="alert">
          Could not load captured tweets.
        </Panel>
      ) : tweets.length === 0 ? (
        <Panel className={styles.statusPanel}>No posts in the last 48 hours.</Panel>
      ) : (
        <div className={styles.columns}>
          <Column
            title="Posts"
            tweets={tweets.filter((tweet) => !tweet.isReply)}
            now={now}
            enteringIds={enteringIds}
            onEntered={onEntered}
          />
          <Column
            title="Replies"
            tweets={tweets.filter((tweet) => tweet.isReply)}
            now={now}
            enteringIds={enteringIds}
            onEntered={onEntered}
          />
        </div>
      )}
    </section>
  );
}
