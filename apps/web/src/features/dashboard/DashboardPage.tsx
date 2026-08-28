import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchRefresh, fetchTweets, openTweetStream, startRefresh, startWatch, stopWatch } from '@/shared/api/tweets';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './DashboardPage.module.css';

const HANDLE = 'thsottiaux';

type Tweets = Awaited<ReturnType<typeof fetchTweets>>['tweets'];

function Column({ title, tweets }: { title: string; tweets: Tweets }) {
  return (
    <Panel className={styles.column}>
      <h2 className={styles.columnTitle}>{title}</h2>
      <div className={styles.rows}>
        {tweets.map((tweet) => (
          <article key={tweet.id} className={styles.tweet}>
            <time className={styles.when} dateTime={new Date(tweet.date).toISOString()}>
              {new Date(tweet.date).toLocaleString()}
            </time>
            <p>{tweet.text}</p>
            <small>
              ♥ {tweet.likeCount} · ↻ {tweet.retweetCount} · ↩ {tweet.replyCount}
            </small>
            <a href={tweet.url} target="_blank" rel="noreferrer">
              Open on X
            </a>
          </article>
        ))}
      </div>
    </Panel>
  );
}

export function DashboardPage() {
  const client = useQueryClient();
  /*
   * Polled only while a run is live: `refetchInterval` returning `false` is
   * what stops this becoming a request every second for the whole session,
   * which is what a fixed interval would be on a page that is idle almost all
   * of the time.
   */
  const refresh = useQuery({
    queryKey: ['tweets-refresh', HANDLE],
    queryFn: ({ signal }) => fetchRefresh(HANDLE, signal),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1000 : false),
  });
  const start = useMutation({
    mutationFn: () => startRefresh(HANDLE),
    onSuccess: () => void refresh.refetch(),
    // The capture appends to the file the tweet query reads, so the list is
    // stale the moment a run ends — settled rather than success, because a
    // failed run can still have written the rows it got before it stopped.
    onSettled: () => void client.invalidateQueries({ queryKey: ['tweets', HANDLE] }),
  });
  const query = useQuery({
    queryKey: ['tweets', HANDLE],
    queryFn: ({ signal }) => fetchTweets(HANDLE, signal),
    // SSE makes a new row immediate; this remains the cheap recovery path if
    // a proxy drops that long-lived connection.
    refetchInterval: 60_000,
  });
  useEffect(() => {
    void startWatch(HANDLE);
    const close = openTweetStream(HANDLE, () => void client.invalidateQueries({ queryKey: ['tweets', HANDLE] }));
    return () => {
      close();
      void stopWatch(HANDLE);
    };
  }, [client]);
  const tweets = query.data?.tweets ?? [];
  const running = refresh.data?.state === 'running';

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        title={`@${HANDLE}`}
        className={styles.header}
        actions={
          <button
            type="button"
            className={styles.refresh}
            onClick={() => start.mutate()}
            disabled={running || start.isPending}
          >
            {running ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      {running ? (
        <p className={styles.progress} role="status">
          Scrolled {refresh.data?.scroll ?? 0} · {refresh.data?.new ?? 0} new
        </p>
      ) : null}
      {refresh.data?.state === 'failed' ? (
        <Panel role="alert">{refresh.data.error ?? 'The refresh failed.'}</Panel>
      ) : null}
      {query.isLoading ? (
        <Panel>Loading tweets…</Panel>
      ) : query.isError ? (
        <Panel role="alert">Could not load captured tweets.</Panel>
      ) : tweets.length === 0 ? (
        <Panel>Nothing captured yet. Run the X scraper to populate this dashboard.</Panel>
      ) : (
        <div className={styles.columns}>
          <Column title="Posts" tweets={tweets.filter((tweet) => !tweet.isReply)} />
          <Column title="Replies" tweets={tweets.filter((tweet) => tweet.isReply)} />
        </div>
      )}
    </section>
  );
}
