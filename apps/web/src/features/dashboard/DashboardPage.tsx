import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchRefresh, fetchTweets, startRefresh } from '@/shared/api/tweets';
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
            <time dateTime={new Date(tweet.date).toISOString()}>{new Date(tweet.date).toLocaleString()}</time>
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
  const refresh = useQuery({ queryKey: ["tweets-refresh", HANDLE], queryFn: () => fetchRefresh(HANDLE), refetchInterval: (q) => q.state.data?.state === "running" ? 1000 : false });
  const start = useMutation({ mutationFn: () => startRefresh(HANDLE), onSuccess: () => void refresh.refetch(), onSettled: () => void client.invalidateQueries({ queryKey: ["tweets", HANDLE] }) });
  const query = useQuery({
    queryKey: ['tweets', HANDLE],
    queryFn: ({ signal }) => fetchTweets(HANDLE, signal),
  });
  const tweets = query.data?.tweets ?? [];

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader title={`@${HANDLE}`} className={styles.header} actions={<button type="button" onClick={() => start.mutate()} disabled={start.isPending || refresh.data?.state === "running"}>Refresh</button>} />
      {refresh.data?.state === "running" ? <p>Refreshing: scroll {refresh.data.scroll}, new {refresh.data.new}</p> : null}
      {refresh.data?.state === "failed" ? <Panel role="alert">{refresh.data.error}</Panel> : null}
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
