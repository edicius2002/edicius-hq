import { useQuery } from '@tanstack/react-query';

import { fetchTweets } from '@/shared/api/tweets';
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
            <p>{tweet.text}</p>
            <small>
              {new Date(tweet.date).toLocaleString()} · ♥ {tweet.likeCount} · ↻ {tweet.retweetCount} · ↩{' '}
              {tweet.replyCount}
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
  const query = useQuery({
    queryKey: ['tweets', HANDLE],
    queryFn: ({ signal }) => fetchTweets(HANDLE, signal),
  });
  const tweets = query.data?.tweets ?? [];

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader title={`@${HANDLE}`} className={styles.header} />
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
