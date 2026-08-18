import type { CollectResponse } from '@/shared/api/fares';
import { Panel } from '@/shared/ui/Panel';

import styles from './AirfarePage.module.css';

/**
 * What one collection pass did, including what it could not do.
 *
 * Decisions 8.8 and 8.41: a refusal travels beside the routes that worked and
 * says why. Hiding them would make a scraper that stopped reading the page look
 * exactly like a week in which no price moved.
 *
 * It also reports when a route was served by something other than the provider
 * the pass asked for. That is not bookkeeping — the fallback answers a narrower
 * question (one cached cheapest fare per date, rather than every departure), so
 * a point it produced is a coarser observation than the rest of the series, and
 * a series that quietly changes what it measures is worse than a gap.
 *
 * No provider is named in this file. `primary` and `sources` arrive from the
 * server and are compared to each other, which is decision 8.3 holding on the
 * browser side of the wire too.
 */
export function CollectionSummary({ report }: { report: CollectResponse }) {
  const failures = report.results.filter((result) => !result.ok);
  const fellBack = report.sources.filter((source) => source !== report.primary);

  return (
    <Panel>
      <h2 className={styles.panelTitle}>Last collection</h2>
      <p className={styles.note}>
        {report.collected} collected, {report.failed} failed
        {report.sources.length > 0 ? `, via ${report.sources.join(' and ')}` : ''}.
      </p>

      {fellBack.length > 0 ? (
        <p className={styles.note}>
          Served by {fellBack.join(' and ')} rather than {report.primary}. A fallback reports one
          cached cheapest fare per date, not every departure, so those points are a coarser
          observation than the rest of the series.
        </p>
      ) : null}

      {failures.length > 0 ? (
        <ul className={styles.failures}>
          {failures.map((failure) => (
            <li key={`${failure.origin}-${failure.destination}-${failure.flightDate}`}>
              {failure.origin} → {failure.destination} ({failure.flightDate}): {failure.errorCode} —{' '}
              {failure.errorMessage}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
