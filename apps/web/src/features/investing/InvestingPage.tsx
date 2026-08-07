import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { CandleChart } from '@/features/investing/chart/CandleChart';
import { useCandles } from '@/features/investing/chart/useCandles';
import { PRIORITY, quoteBus } from '@/features/investing/data/quoteBus';
import { useWatchlist } from '@/features/investing/hooks/useWatchlist';
import { cadenceFor } from '@/features/investing/lib/session';
import { SymbolSearch } from '@/features/investing/ui/SymbolSearch';
import { TickerTape } from '@/features/investing/ui/TickerTape';
import { Watchlist } from '@/features/investing/ui/Watchlist';
import type { Bar, Quote } from '@/shared/api/market';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './ui/InvestingPage.module.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1d', '1w', '1M'] as const;

/**
 * What the exchange calls its own session, in words. Taken over our clock for
 * display because it knows about holidays, which `regimeAt` deliberately does
 * not model.
 */
const MARKET_STATE_LABEL: Record<string, string> = {
  REGULAR: 'Market open',
  PRE: 'Pre-market',
  PREPRE: 'Pre-market',
  POST: 'After hours',
  POSTPOST: 'After hours',
  CLOSED: 'Market closed',
};

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
  const watchlist = useWatchlist();
  const [symbol, setSymbol] = useState('AAPL');
  const [timeframe, setTimeframe] = useState<string>('1d');

  const candles = useCandles(symbol, timeframe);
  const formatTime = useMemo(() => timeFormatter(timeframe), [timeframe]);

  // The charted symbol rides along with the watchlist, so the whole screen is
  // one request rather than one for the list and another for what it points at.
  const wanted = useMemo(
    () => (watchlist.symbols.includes(symbol) ? watchlist.symbols : [symbol, ...watchlist.symbols]),
    [watchlist.symbols, symbol],
  );

  const quotes = useQuery({
    queryKey: ['market', 'quotes', wanted],
    queryFn: () => quoteBus.quotes(wanted, { priority: PRIORITY.watchlist }),
    enabled: wanted.length > 0,
    refetchInterval: cadenceFor(candles.regime, 0).quotesMs,
  });

  const bySymbol = useMemo(() => {
    const map = new Map<string, Quote>();
    for (const quote of quotes.data?.quotes ?? []) map.set(quote.symbol, quote);
    return map;
  }, [quotes.data]);

  const learnNames = watchlist.learnNames;
  // A symbol added by hand starts named after itself; the provider knows better.
  useEffect(() => {
    const names = new Map<string, string>();
    for (const [key, quote] of bySymbol) if (quote.name) names.set(key, quote.name);
    if (names.size) void learnNames(names);
  }, [bySymbol, learnNames]);

  const charted = bySymbol.get(symbol);
  const marketState = charted?.marketState;
  const statusLabel =
    (marketState ? MARKET_STATE_LABEL[marketState] : undefined) ?? REGIME_LABEL[candles.regime];
  const ghosts = candles.bars.filter((bar, index) => candles.isGhost(bar, index)).length;

  return (
    <section className={styles.page} aria-labelledby="investing-title">
      <PageHeader
        title="Investing"
        subtitle="Markets. Follow what matters and chart it."
        titleId="investing-title"
      />

      <TickerTape quotes={quotes.data?.quotes ?? []} onSelect={setSymbol} />

      {/* Chart on the left, watchlist on the right — the same shape Finance uses
          for its canvas and side panel, and the arrangement that makes clicking
          a row and reading the answer one movement rather than two. */}
      <div className={styles.workspace}>
        <Panel aria-label={`${symbol} chart`}>
          <div className={styles.chartHeader}>
            <h2 className={styles.symbol}>{symbol}</h2>
            {charted ? (
              <>
                <span className={styles.price}>
                  {charted.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <span className={styles.muted}> {charted.currency}</span>
                </span>
                {charted.extended ? (
                  /* Says which session the number is from, so a price that
                     disagrees with yesterday's close reads as live rather than
                     as a bug. */
                  <span className={styles.extendedTag} title={statusLabel}>
                    {marketState?.startsWith('PRE') ? 'PRE' : 'AH'}
                  </span>
                ) : null}
                <span className={(charted.changePercent ?? 0) >= 0 ? styles.up : styles.down}>
                  {charted.changePercent === null
                    ? '—'
                    : `${charted.changePercent >= 0 ? '+' : ''}${charted.changePercent.toFixed(2)}%`}
                </span>
              </>
            ) : null}

            <span className={styles.spacer} />

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
            {candles.bars.length} bars
            {ghosts > 0 ? <> · {ghosts} extended</> : null}
            {candles.provider ? <> · {candles.provider}</> : null} · drag to pan, scroll to zoom
          </p>
        </Panel>

        <Panel className={styles.side} aria-label="Watchlist">
          <div className={styles.sideHeader}>
            <h2 className={styles.sectionTitle}>Watchlist</h2>
            <span className={`${styles.regime} ${styles[candles.regime]}`}>{statusLabel}</span>
          </div>

          <SymbolSearch
            following={new Set(watchlist.symbols)}
            onPick={(picked, name) => {
              void watchlist.add(picked, name);
              setSymbol(picked);
            }}
          />

          {watchlist.isError ? (
            <p className={styles.error} role="alert">
              Could not load the watchlist.
            </p>
          ) : (
            <Watchlist
              entries={watchlist.list.entries}
              quotes={bySymbol}
              selected={symbol}
              onSelect={setSymbol}
              onRemove={(picked) => void watchlist.remove(picked)}
              onMove={(from, to) => void watchlist.move(from, to)}
            />
          )}
        </Panel>
      </div>
    </section>
  );
}
