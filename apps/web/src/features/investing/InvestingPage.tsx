import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { CandleChart } from '@/features/investing/chart/CandleChart';
import { useCandles } from '@/features/investing/chart/useCandles';
import { PRIORITY, quoteBus } from '@/features/investing/data/quoteBus';
import { applyTicks } from '@/features/investing/data/quoteStream';
import { activePanes } from '@/features/investing/data/indicators';
import { useIndicatorSeries } from '@/features/investing/hooks/useIndicatorSeries';
import { useIndicators } from '@/features/investing/hooks/useIndicators';
import { usePortfolio } from '@/features/investing/hooks/usePortfolio';
import { useQuoteStream } from '@/features/investing/hooks/useQuoteStream';
import { useWatchlist } from '@/features/investing/hooks/useWatchlist';
import { cadenceFor } from '@/features/investing/lib/session';
import { IndicatorBar } from '@/features/investing/ui/IndicatorBar';
import { MarketRail } from '@/features/investing/ui/MarketRail';
import { Positions } from '@/features/investing/ui/Positions';
import { SymbolSearch } from '@/features/investing/ui/SymbolSearch';
import { TickerTape } from '@/features/investing/ui/TickerTape';
import { Watchlist } from '@/features/investing/ui/Watchlist';
import type { Bar, Quote } from '@/shared/api/market';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import { formatPercent, formatAmount } from '@/shared/lib/money';

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
  const holdings = usePortfolio();
  const [symbol, setSymbol] = useState('AAPL');
  const [timeframe, setTimeframe] = useState<string>('1d');
  const [marketPanelOpen, setMarketPanelOpen] = useState(true);
  const [chartFocused, setChartFocused] = useState(false);

  // Focus mode is a chart workspace, not a browser fullscreen request. Escape
  // always returns to the page and the body cannot scroll behind the fixed
  // surface while it is open.
  useEffect(() => {
    if (!chartFocused) return;

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChartFocused(false);
    };

    document.body.style.overflow = 'hidden';
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [chartFocused]);

  const candles = useCandles(symbol, timeframe);
  const { indicators, toggle: toggleIndicator } = useIndicators();
  // Functions of the bars alone, so they survive every pan and zoom untouched.
  const series = useIndicatorSeries(candles.bars, indicators, timeframe);
  const panes = useMemo(() => activePanes(indicators), [indicators]);
  const formatTime = useMemo(() => timeFormatter(timeframe), [timeframe]);

  // The charted symbol rides along with the watchlist, so the whole screen is
  // one request rather than one for the list and another for what it points at.
  // Everything that needs a price: what you follow, what you hold, and what is
  // charted. One request covers all three — a position values itself from the
  // same quote the watchlist row is already showing.
  const wanted = useMemo(() => {
    const seen = new Set<string>([symbol, ...watchlist.symbols, ...holdings.symbols]);
    return [...seen];
  }, [watchlist.symbols, holdings.symbols, symbol]);

  // Prices arrive by push. Asked before the sweep is set up, because how often
  // to sweep depends on whether the stream is carrying — and not the reverse.
  const { ticks, live, discardTicksBefore } = useQuoteStream(wanted);

  // The poll behind it is a sweep, not a cadence, and it slows only while the
  // stream is actually live: a dead socket puts the page straight back on the
  // rate it had before any of this existed.
  const quotes = useQuery({
    queryKey: ['market', 'quotes', wanted],
    queryFn: () => quoteBus.quotes(wanted, { priority: PRIORITY.watchlist }),
    enabled: wanted.length > 0,
    refetchInterval: cadenceFor(candles.regime, 0, { streaming: live }).quotesMs,
  });

  // Quotes do not carry their own market timestamp. React Query's update time
  // is therefore the best sweep boundary available here; it is milliseconds,
  // while the stream contract uses seconds. A tick without a timestamp stays
  // visible because it cannot honestly be ordered against the sweep.
  useEffect(() => {
    if (quotes.dataUpdatedAt) discardTicksBefore(quotes.dataUpdatedAt / 1000);
  }, [quotes.dataUpdatedAt, discardTicksBefore]);

  // The reasons decision 8.8 sends beside the quotes that worked. They reached
  // the page and stopped there, so a refused row showed the same "·" as one
  // still loading — forever.
  const failures = useMemo(() => {
    const map = new Map<string, { code: string; message: string }>();
    for (const failure of quotes.data?.failed ?? []) {
      map.set(failure.symbol, { code: failure.code, message: failure.message });
    }
    return map;
  }, [quotes.data]);

  const swept = useMemo(() => {
    const map = new Map<string, Quote>();
    for (const quote of quotes.data?.quotes ?? []) map.set(quote.symbol, quote);
    return map;
  }, [quotes.data]);

  // The swept quotes with every tick since laid over them. The sweep is the
  // row; the stream only moves the price on it.
  const bySymbol = useMemo(
    () => applyTicks(swept, [...ticks.values()]),
    [swept, ticks],
  );
  const tapeQuotes = useMemo(
    () => wanted.flatMap((wantedSymbol) => {
      const quote = bySymbol.get(wantedSymbol);
      return quote ? [quote] : [];
    }),
    [wanted, bySymbol],
  );

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
    <section
      className={`${styles.page} ${chartFocused ? styles.focusMode : ''}`}
      aria-labelledby={chartFocused ? undefined : 'investing-title'}
      aria-label={chartFocused ? 'Focused investing chart' : undefined}
    >
      <PageHeader
        title="Investing"
        subtitle="Markets. Follow what matters and chart it."
        titleId="investing-title"
        className={styles.pageHeader}
      />

      <div className={styles.tickerWrap}>
        <TickerTape quotes={tapeQuotes} onSelect={setSymbol} />
      </div>

      <div
        className={`${styles.workspace} ${!marketPanelOpen || chartFocused ? styles.workspaceWide : ''}`}
      >
        <Panel className={styles.chartPanel} aria-label={`${symbol} chart`}>
          <div className={styles.chartHeader}>
            <h2 className={styles.symbol}>{symbol}</h2>
            {charted ? (
              <>
                <span className={styles.price}>
                  {formatAmount(charted.price)}
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
                  {formatPercent(charted.changePercent)}
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

            <div className={styles.viewControls}>
              {!chartFocused ? (
                <button
                  type="button"
                  className={styles.viewControl}
                  aria-expanded={marketPanelOpen}
                  aria-controls="market-panel"
                  aria-label={marketPanelOpen ? 'Hide markets' : 'Show markets'}
                  title={marketPanelOpen ? 'Hide market panel' : 'Show market panel'}
                  onClick={() => setMarketPanelOpen((open) => !open)}
                >
                  Markets
                </button>
              ) : null}
              <button
                type="button"
                className={styles.viewControl}
                aria-pressed={chartFocused}
                aria-label={chartFocused ? 'Exit focus' : 'Focus chart'}
                title={chartFocused ? 'Exit chart focus' : 'Focus chart'}
                onClick={() => setChartFocused((focused) => !focused)}
              >
                {chartFocused ? 'Exit' : 'Focus'}
              </button>
            </div>
          </div>

          {candles.isError ? (
            <p className={styles.error} role="alert">
              Could not load bars for {symbol}.
            </p>
          ) : (
            <CandleChart
              bars={candles.bars}
              viewKey={`${symbol}:${timeframe}`}
              indicators={series}
              panes={panes}
              isGhost={candles.isGhost}
              formatTime={formatTime}
              loading={candles.isPending}
            />
          )}

          <IndicatorBar
            indicators={indicators}
            timeframe={timeframe}
            onToggle={(id) => void toggleIndicator(id)}
          />

          <p className={styles.note}>
            {candles.bars.length} bars
            {ghosts > 0 ? <> · {ghosts} extended</> : null}
            {candles.isStale ? <> · data delayed</> : null}
            {candles.provider ? <> · {candles.provider}</> : null} · drag to pan, scroll to zoom
          </p>
        </Panel>

        <div className={styles.marketPanelSlot}>
          <MarketRail
            regime={candles.regime}
            statusLabel={statusLabel}
            hidden={!marketPanelOpen || chartFocused}
            watchlist={
              <div className={styles.column}>
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
                    failures={failures}
                    selected={symbol}
                    onSelect={setSymbol}
                    onRemove={(picked) => void watchlist.remove(picked)}
                    onMove={(from, to) => void watchlist.move(from, to)}
                  />
                )}
              </div>
            }
            positions={
              <div className={styles.column}>
                {holdings.isError ? (
                  <p className={styles.error} role="alert">
                    Could not load your positions.
                  </p>
                ) : (
                  <Positions
                    portfolio={holdings.portfolio}
                    quotes={bySymbol}
                    selected={symbol}
                    onSelect={setSymbol}
                    onEdit={(picked, quantity, averageCost) =>
                      void holdings.set(picked, quantity, averageCost)
                    }
                    onRemove={(picked) => void holdings.remove(picked)}
                    onMove={(from, to) => void holdings.move(from, to)}
                  />
                )}
              </div>
            }
          />
        </div>
      </div>
    </section>
  );
}
