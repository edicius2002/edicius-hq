import type { SentimentClassification, SentimentMetric } from '@/shared/api/sentiment';
import { useSentiment } from '@/features/sentiment/hooks/useSentiment';
import { SentimentChart } from '@/features/sentiment/ui/SentimentChart';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './SentimentPage.module.css';

const CNN_SENTIMENT_URL = 'https://edition.cnn.com/markets/fear-and-greed';
const timestampFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

function classificationLabel(classification: SentimentClassification): string {
  return classification.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scoreLabel(score: number): string {
  return score.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function MetricPanel({
  metric,
  featured = false,
}: {
  metric: SentimentMetric;
  featured?: boolean;
}) {
  const titleId = `sentiment-${metric.key}-title`;

  return (
    <Panel
      className={featured ? `${styles.metric} ${styles.featured}` : styles.metric}
      aria-labelledby={titleId}
    >
      <header className={styles.metricHeader}>
        <div>
          <h2 id={titleId} className={styles.metricTitle}>
            {metric.label}
          </h2>
          <time className={styles.metricTime} dateTime={metric.timestamp}>
            As of {timestampFormat.format(new Date(metric.timestamp))}
          </time>
        </div>
        <div className={styles.score} data-classification={metric.classification}>
          <strong>{scoreLabel(metric.score)}</strong>
          <span>{classificationLabel(metric.classification)}</span>
        </div>
      </header>
      <SentimentChart metric={metric} />
    </Panel>
  );
}

export function SentimentPage() {
  const query = useSentiment();
  const data = query.data;
  const metrics =
    data?.composite && Array.isArray(data.indicators) ? [data.composite, ...data.indicators] : [];
  const hasCompleteHistory =
    metrics.length === 8 && metrics.every((metric) => metric.series[0]?.points.length > 0);

  return (
    <section className={styles.page} aria-labelledby="page-title">
      <PageHeader
        subtitle="CNN Fear & Greed Index and the seven market signals behind it."
        actions={
          <a href={CNN_SENTIMENT_URL} target="_blank" rel="noreferrer">
            CNN Fear &amp; Greed Index
          </a>
        }
      />

      {query.isPending ? (
        <Panel className={styles.state} role="status">
          Loading sentiment…
        </Panel>
      ) : query.isError ? (
        <Panel className={styles.state} role="alert">
          <p>Sentiment is unavailable. CNN may be temporarily unreachable.</p>
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Panel>
      ) : !data || !hasCompleteHistory ? (
        <Panel className={styles.state} role="status">
          No sentiment history is available yet.
        </Panel>
      ) : (
        <>
          <div className={styles.provenance}>
            <span>
              Source: CNN · Retrieved{' '}
              <time dateTime={data.fetchedAt}>
                {timestampFormat.format(new Date(data.fetchedAt))}
              </time>
            </span>
            <span>
              Snapshot as of{' '}
              <time dateTime={data.asOf}>{timestampFormat.format(new Date(data.asOf))}</time>
            </span>
          </div>

          {data.stale ? (
            <Panel className={styles.stale} role="status" aria-label="Stale data">
              CNN could not be refreshed, so this is the last known snapshot. Check the retrieval
              time before acting on it.
            </Panel>
          ) : null}

          <MetricPanel metric={data.composite} featured />
          <div className={styles.indicators}>
            {data.indicators.map((indicator) => (
              <MetricPanel key={indicator.key} metric={indicator} />
            ))}
          </div>

          <p className={styles.disclaimer}>
            Scores and classifications are supplied by CNN. Historical indicator charts show each
            indicator's native measurement, which is not necessarily a 0–100 score.
          </p>
        </>
      )}
    </section>
  );
}
