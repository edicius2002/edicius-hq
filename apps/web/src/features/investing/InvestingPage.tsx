import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { PRIORITY, quoteBus } from '@/features/investing/data/quoteBus';
import { getBars } from '@/shared/api/market';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './ui/InvestingPage.module.css';

/**
 * Scaffolding, and deliberately so.
 *
 * INV-01 builds the data plane and draws nothing; this panel exists only to
 * prove the plane end to end in the real app rather than only in tests — a
 * quote, a bar count, and which upstream answered. INV-02 and INV-03 replace it
 * with the chart and the watchlist.
 */

const SEED = ['AAPL', 'BTCUSDT'];
const TIMEFRAME = '1d';

export function InvestingPage() {
  const [symbols, setSymbols] = useState(SEED);
  const [draft, setDraft] = useState('');

  const quotes = useQuery({
    queryKey: ['market', 'quotes', symbols],
    queryFn: () => quoteBus.quotes(symbols, { priority: PRIORITY.watchlist }),
    // The bus has its own TTL; this only decides when to ask it again.
    refetchInterval: 15_000,
  });

  const bars = useQuery({
    queryKey: ['market', 'bars', symbols[0], TIMEFRAME],
    queryFn: () => getBars(symbols[0], TIMEFRAME),
    enabled: symbols.length > 0,
  });

  function addSymbol() {
    const wanted = draft.trim().toUpperCase();
    if (!wanted || symbols.includes(wanted)) return;
    setSymbols((current) => [...current, wanted]);
    setDraft('');
  }

  return (
    <section className={styles.page} aria-labelledby="investing-title">
      <PageHeader
        title="Investing"
        subtitle="Markets. The data plane is in; the surfaces come next."
        titleId="investing-title"
      />

      <Panel>
        <p className={styles.note}>
          A check that quotes and bars arrive, not the finished page. The chart, the watchlist and
          the rest land in their own slices.
        </p>

        <div className={styles.controls}>
          <input
            className={styles.input}
            value={draft}
            placeholder="Add a symbol, e.g. MSFT or ETHUSDT"
            aria-label="Symbol"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addSymbol();
            }}
          />
          <Button onClick={addSymbol}>Add</Button>
          {/* Refreshes everything on screen; refreshing half of it would be a
              button that sometimes appears not to work. */}
          <Button
            onClick={() => {
              void quotes.refetch();
              void bars.refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      </Panel>

      <Panel aria-label="Quotes">
        <h2 className={styles.sectionTitle}>Quotes</h2>

        {quotes.isPending ? <p className={styles.note}>Asking…</p> : null}
        {quotes.isError ? (
          <p className={styles.error} role="alert">
            Could not reach the market data service.
          </p>
        ) : null}

        {quotes.data?.quotes?.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Price</th>
                <th scope="col">Change</th>
                <th scope="col">Served by</th>
              </tr>
            </thead>
            <tbody>
              {quotes.data.quotes.map((quote) => (
                <tr key={quote.symbol}>
                  <th scope="row">{quote.symbol}</th>
                  <td className={styles.number}>
                    {quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                    <span className={styles.muted}>{quote.currency}</span>
                  </td>
                  <td
                    className={`${styles.number} ${
                      (quote.changePercent ?? 0) >= 0 ? styles.up : styles.down
                    }`}
                  >
                    {quote.changePercent === null
                      ? '—'
                      : `${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%`}
                  </td>
                  <td className={styles.muted}>{quote.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {/* A symbol nobody could serve says so, rather than quietly vanishing. */}
        {quotes.data?.failed?.length ? (
          <ul className={styles.failures}>
            {quotes.data.failed.map((failure) => (
              <li key={failure.symbol}>
                <strong>{failure.symbol}</strong> — {failure.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel aria-label="Bars">
        <h2 className={styles.sectionTitle}>Bars</h2>
        {bars.isPending ? <p className={styles.note}>Asking…</p> : null}
        {bars.isError ? (
          <p className={styles.error} role="alert">
            Could not load bars for {symbols[0]}.
          </p>
        ) : null}
        {bars.data?.bars ? (
          <p className={styles.note}>
            <strong>{bars.data.bars.length}</strong> bars for <strong>{bars.data.symbol}</strong> at{' '}
            {bars.data.timeframe}, served by {bars.data.provider}
            {bars.data.bars.length ? (
              <>
                {' '}
                · last close{' '}
                <strong>{bars.data.bars[bars.data.bars.length - 1].close.toLocaleString()}</strong>
              </>
            ) : null}
          </p>
        ) : null}
      </Panel>
    </section>
  );
}
