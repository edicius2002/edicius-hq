import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { CandleChart } from '@/features/investing/chart/CandleChart';
import { useCandles } from '@/features/investing/chart/useCandles';
import { PRIORITY, quoteBus } from '@/features/investing/data/quoteBus';
import { cadenceFor } from '@/features/investing/lib/session';
import type { Bar } from '@/shared/api/market';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './ui/InvestingPage.module.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1d', '1w', '1M'] as const;

const REGIME_LABEL = {
  regular: 'Market open',
  extended: 'Extended hours',
  closed: 'Market closed',
} as const;

/** Intraday frames want a clock; anything daily or longer wants a date. */
function timeFormatter(timeframe: string) {
  const intraday = ['1m', '5m', '15m', '1h'].includes(timeframe);
  const format = new Intl.DateTimeFormat(
    undefined,
    intraday
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: 'short', year: timeframe === '1M' ? '2-digit' : undefined },
  );
  return (bar: Bar) => format.format(new Date(bar.time * 1000));
}

export function InvestingPage() {
  const [symbol, setSymbol] = useState('AAPL');
  const [timeframe, setTimeframe] = useState<string>('1d');
  const [draft, setDraft] = useState('');

  const candles = useCandles(symbol, timeframe);
  const formatTime = useMemo(() => timeFormatter(timeframe), [timeframe]);

  const quotes = useQuery({
    queryKey: ['market', 'quotes', symbol],
    queryFn: () => quoteBus.quotes([symbol], { priority: PRIORITY.chart }),
    refetchInterval: cadenceFor(candles.regime, 0).quotesMs,
  });

  const quote = quotes.data?.quotes?.[0];
  const ghosts = candles.bars.filter(candles.isGhost).length;

  function submitSymbol() {
    const wanted = draft.trim().toUpperCase();
    if (!wanted) return;
    setSymbol(wanted);
    setDraft('');
  }

  return (
    <section className={styles.page} aria-labelledby="investing-title">
      <PageHeader
        title="Investing"
        subtitle="Markets. One symbol for now; the watchlist and the rest come next."
        titleId="investing-title"
      />

      <Panel>
        <div className={styles.controls}>
          <input
            className={styles.input}
            value={draft}
            placeholder={`Symbol — showing ${symbol}`}
            aria-label="Symbol"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitSymbol();
            }}
          />
          <Button onClick={submitSymbol}>Show</Button>

          <div className={styles.timeframes} role="group" aria-label="Timeframe">
            {TIMEFRAMES.map((frame) => (
              <button
                key={frame}
                type="button"
                className={`${styles.timeframe} ${frame === timeframe ? styles.timeframeOn : ''}`}
                aria-pressed={frame === timeframe}
                onClick={() => setTimeframe(frame)}
              >
                {frame}
              </button>
            ))}
          </div>

          <span className={styles.spacer} />

          {/* Says which regime the chart is in, because it explains both the
              translucent candles and why polling slowed down. */}
          <span className={`${styles.regime} ${styles[candles.regime]}`}>
            {REGIME_LABEL[candles.regime]}
          </span>
        </div>
      </Panel>

      <Panel aria-label={`${symbol} chart`}>
        <div className={styles.chartHeader}>
          <h2 className={styles.symbol}>{symbol}</h2>
          {quote ? (
            <>
              <span className={styles.price}>
                {quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                <span className={styles.muted}> {quote.currency}</span>
              </span>
              <span className={(quote.changePercent ?? 0) >= 0 ? styles.up : styles.down}>
                {quote.changePercent === null
                  ? '—'
                  : `${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%`}
              </span>
            </>
          ) : null}

          <span className={styles.spacer} />

          <span className={styles.meta}>
            {candles.bars.length} bars
            {ghosts > 0 ? <> · {ghosts} extended</> : null}
            {candles.provider ? <> · {candles.provider}</> : null}
          </span>
          <Button onClick={candles.refetch}>Refresh</Button>
        </div>

        {candles.isError ? (
          <p className={styles.error} role="alert">
            Could not load bars for {symbol}.
          </p>
        ) : (
          <CandleChart
            bars={candles.bars}
            isGhost={candles.isGhost}
            formatTime={formatTime}
            loading={candles.isPending}
          />
        )}

        <p className={styles.note}>
          Drag to pan, scroll to zoom. Candles outside the regular session are drawn translucent and
          disappear when the market opens.
        </p>
      </Panel>
    </section>
  );
}
