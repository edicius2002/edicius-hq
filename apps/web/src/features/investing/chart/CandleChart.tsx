import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import {
  drawOverlays,
  drawPane,
  type IndicatorSeries,
} from '@/features/investing/chart/indicatorLayers';
import { drawPriceLines, positionPriceLine } from '@/features/investing/chart/priceLines';
import type { Position } from '@/features/investing/data/portfolio';
import { layoutPanes, type PaneId, type PaneLayout } from '@/features/investing/lib/panes';

import {
  barWidth,
  clampWindow,
  indexAt,
  panWindow,
  priceRange,
  priceScale,
  priceTicks,
  timeTicks,
  minVisibleBars,
  visibleBars,
  wickWidth,
  xAt,
  zoomWindow,
  type IndexWindow,
} from '@/features/investing/lib/scales';
import type { Bar } from '@/shared/api/market';
import { useElementSize } from '@/shared/lib/useElementSize';

import styles from './CandleChart.module.css';

/**
 * The chart, drawn by hand.
 *
 * Two canvases stacked. The lower one holds the candles and the axes and is
 * repainted only when the data, the window or the size change. The upper one
 * holds the crosshair, which moves with every pointer event — repainting
 * fifteen hundred candles to move a hairline would waste the frame, the same
 * lesson the Finance edge layer taught.
 */

/** Room for the price labels on the right and the time labels underneath. */
const GUTTER_RIGHT = 64;
const GUTTER_BOTTOM = 24;

const WHEEL_STEP = 1.15;
const DEFAULT_VISIBLE = 120;

type CandleChartProps = {
  bars: Bar[];
  /** Identity of the series whose view is on screen. */
  viewKey: string;
  /** Names the chart for people who cannot inspect its pixels. */
  symbol: string;
  timeframe: string;
  /** Precomputed series, index-aligned with `bars`. Absent means "not on". */
  indicators?: IndicatorSeries;
  /** Which panes to open below the price, in the order they are drawn. */
  panes?: PaneId[];
  /** The open position on `symbol`, if any — draws its entry as a dashed reference line. */
  position?: Position;
  /** Whether a bar falls outside the regular session, and so draws translucent. */
  isGhost: (bar: Bar, index: number) => boolean;
  /** How to label a bar on the time axis; the chart does not own the calendar. */
  formatTime: (bar: Bar) => string;
  loading?: boolean;
};

type Crosshair = { x: number; y: number; index: number } | null;

export function CandleChart({
  bars,
  viewKey,
  symbol,
  timeframe,
  indicators,
  panes,
  position,
  isGhost,
  formatTime,
  loading,
}: CandleChartProps) {
  const [frameRef, size] = useElementSize<HTMLDivElement>();
  const candleRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const [window, setWindow] = useState<IndexWindow>({ first: 0, last: DEFAULT_VISIBLE });
  const [shownViewKey, setShownViewKey] = useState(viewKey);
  const [following, setFollowing] = useState(true);
  const [crosshair, setCrosshair] = useState<Crosshair>(null);
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [drag, setDrag] = useState<{ pointerId: number; x: number; from: IndexWindow } | null>(
    null,
  );

  // Every chart begins at the live edge. A chart may stay mounted while its
  // symbol or timeframe changes, so reset during render before a former series
  // can draw through the new one.
  if (shownViewKey !== viewKey) {
    setShownViewKey(viewKey);
    setWindow({ first: 0, last: DEFAULT_VISIBLE });
    setFollowing(true);
    setCrosshair(null);
    setKeyboardIndex(null);
    setTableOpen(false);
    setDrag(null);
  }

  // Memoised because both draw effects depend on it: a fresh object each
  // render would repaint fifteen hundred candles on every pointer move.
  const plot = useMemo(
    () => ({
      width: Math.max(0, size.width - GUTTER_RIGHT),
      height: Math.max(0, size.height - GUTTER_BOTTOM),
    }),
    [size.width, size.height],
  );

  useEffect(() => {
    if (!following || !bars.length) return;
    setWindow(
      clampWindow(
        { first: bars.length - DEFAULT_VISIBLE, last: bars.length },
        bars.length,
        minVisibleBars(plot),
      ),
    );
  }, [bars, following, plot]);

  // The bands are pure geometry over the plot height, so this is cheap and
  // stable — the draw effect below depends on it and must not see a new object
  // on every render.
  const paneKey = (panes ?? []).join(',');
  const layout = useMemo(
    () => layoutPanes(plot.height, paneKey ? (paneKey.split(',') as PaneId[]) : []),
    [plot.height, paneKey],
  );

  // This is deliberately derived from bars/window only. Pointer motion redraws
  // the overlay, but it must not reformat the screen-reader range or table.
  const shownBars = useMemo(() => visibleBars(bars, window), [bars, window]);
  const visibleRange = useMemo(() => {
    if (!shownBars.length) return 'No bars are visible.';
    const first = shownBars[0];
    const last = shownBars.at(-1);
    return `Showing ${shownBars.length} bars from ${formatTime(first)} to ${formatTime(last ?? first)}.`;
  }, [formatTime, shownBars]);
  const tableRows = useMemo(
    () => (tableOpen ? shownBars.map((bar) => ({ bar })) : []),
    [shownBars, tableOpen],
  );
  // A screen reader user cannot see the dashed line drawn on the canvas below,
  // so the entry price it stands for is spoken here instead.
  const positionSummary = position ? `Position entry at ${position.averageCost.toFixed(2)}.` : '';
  const instructionsId = useId();
  const statusId = useId();
  const tableId = useId();

  useEffect(() => {
    const canvas = candleRef.current;
    if (!canvas || plot.width <= 0 || plot.height <= 0) return;

    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    drawChart(ctx, { bars, window, plot, size, isGhost, formatTime, layout, indicators, position });
  }, [bars, window, plot, size, isGhost, formatTime, layout, indicators, position]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;

    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (crosshair) drawCrosshair(ctx, crosshair, plot, size);
  }, [crosshair, plot, size]);

  function pointerPosition(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const moveWindow = useCallback((change: (current: IndexWindow) => IndexWindow) => {
    setWindow((current) => change(current));
  }, []);

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const { x, y } = pointerPosition(event);

    if (drag && event.pointerId === drag.pointerId) {
      const perBar = plot.width / Math.max(1, drag.from.last - drag.from.first);
      // Dragging right walks back through history, like moving a paper chart.
      const next = panWindow(drag.from, -(x - drag.x) / perBar, bars.length, minVisibleBars(plot));
      // Follow only lets go when the user has actually walked away from the
      // right edge. Dragging into the edge must not disable it by accident.
      if (next.last < bars.length) setFollowing(false);
      moveWindow(() => next);
      return;
    }

    if (x > plot.width || y > plot.height) {
      setCrosshair(null);
      return;
    }
    setKeyboardIndex(null);
    setCrosshair({ x, y, index: Math.round(indexAt(x, window, plot)) });
  }

  function windowContaining(index: number): IndexWindow {
    if (index >= window.first && index < window.last) return window;

    const span = window.last - window.first;
    if (index < window.first) {
      return clampWindow({ first: index, last: index + span }, bars.length, minVisibleBars(plot));
    }
    return clampWindow(
      { first: index - span + 1, last: index + 1 },
      bars.length,
      minVisibleBars(plot),
    );
  }

  function selectBar(index: number) {
    if (!bars.length) return;
    const nextIndex = Math.max(0, Math.min(bars.length - 1, index));
    const nextWindow = windowContaining(nextIndex);
    // Keyboard movement into history is the same intent as dragging there:
    // do not snap the user back to the incoming live edge.
    if (nextIndex < bars.length - 1 || nextWindow.last < bars.length) setFollowing(false);
    setWindow(nextWindow);
    setKeyboardIndex(nextIndex);
    setCrosshair({
      x: xAt(nextIndex, nextWindow, plot),
      y: plot.height / 2,
      index: nextIndex,
    });
  }

  function panByKeyboard(byBars: number) {
    const next = panWindow(window, byBars, bars.length, minVisibleBars(plot));
    if (next.last < bars.length) setFollowing(false);
    setWindow(next);
    setKeyboardIndex(null);
    setCrosshair(null);
  }

  function zoomByKeyboard(factor: number) {
    if (!bars.length) return;
    const pivot = keyboardIndex ?? Math.max(0, Math.ceil(window.last) - 1);
    const next = zoomWindow(window, factor, pivot, bars.length, minVisibleBars(plot));
    if (next.last < bars.length) setFollowing(false);
    setWindow(next);
  }

  function onSurfaceKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const selected = keyboardIndex ?? Math.max(0, Math.ceil(window.last) - 1);
    const panStep = Math.max(1, Math.floor((window.last - window.first) * 0.8));

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        selectBar(selected - 1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        selectBar(selected + 1);
        break;
      case 'Home':
        event.preventDefault();
        selectBar(0);
        break;
      case 'End':
        event.preventDefault();
        selectBar(bars.length - 1);
        break;
      case 'PageUp':
        event.preventDefault();
        panByKeyboard(-panStep);
        break;
      case 'PageDown':
        event.preventDefault();
        panByKeyboard(panStep);
        break;
      case '+':
      case '=':
        event.preventDefault();
        zoomByKeyboard(1 / WHEEL_STEP);
        break;
      case '-':
      case '_':
        event.preventDefault();
        zoomByKeyboard(WHEEL_STEP);
        break;
      default:
        break;
    }
  }

  /*
   * Bound by hand rather than through onWheel: React listens passively, and a
   * passive listener cannot call preventDefault — so zooming would scroll the
   * page out from under the chart. The same trap the Finance camera hit.
   */
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;

    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const factor = event.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP;

      // Composed on the latest window rather than one read from this closure.
      // A trackpad fires far faster than React re-renders, so a listener holding
      // a captured window throws events away — and one that is never re-bound
      // ignores every event after the first.
      moveWindow((current) =>
        zoomWindow(current, factor, indexAt(x, current, plot), bars.length, minVisibleBars(plot)),
      );
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [plot, bars.length, moveWindow]);

  const selected = keyboardIndex === null ? undefined : bars[keyboardIndex];
  const hovered = crosshair ? bars[crosshair.index] : undefined;
  const activeBar = selected ?? hovered;
  const activeIndex = selected && keyboardIndex !== null ? keyboardIndex : crosshair?.index;
  const selectedSummary = selected
    ? `${formatTime(selected)}. Open ${selected.open.toFixed(2)}, high ${selected.high.toFixed(2)}, low ${selected.low.toFixed(2)}, close ${selected.close.toFixed(2)}.`
    : undefined;

  return (
    <div className={styles.chartShell}>
      <div className={styles.chart} ref={frameRef}>
        <canvas
          ref={candleRef}
          className={styles.layer}
          style={{ width: '100%', height: '100%' }}
        />
        <canvas
          ref={overlayRef}
          className={styles.layer}
          style={{ width: '100%', height: '100%' }}
        />

        <div
          ref={surfaceRef}
          className={`${styles.surface} ${drag ? styles.dragging : ''}`}
          role="region"
          aria-roledescription="candlestick chart"
          aria-label={`${symbol} ${timeframe} chart. ${visibleRange} ${
            following ? 'Following latest candles.' : 'Viewing historical candles.'
          } ${positionSummary}`.trim()}
          aria-describedby={`${instructionsId} ${statusId}`}
          tabIndex={0}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDrag({ pointerId: event.pointerId, x: pointerPosition(event).x, from: window });
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => setCrosshair(null)}
          onKeyDown={onSurfaceKeyDown}
        />

        <p id={instructionsId} className={styles.srOnly}>
          Use left and right arrow keys to read candles. Home and End move to the first and latest
          candle. Page Up and Page Down pan. Plus and minus zoom. Moving into history stops
          following the latest candles.
        </p>
        <p id={statusId} className={styles.srOnly} aria-live="polite">
          {selectedSummary ?? visibleRange}
        </p>

        <button
          type="button"
          className={styles.follow}
          aria-pressed={following}
          title="Follow latest candles"
          onClick={() => setFollowing(true)}
        >
          Latest
        </button>

        <button
          type="button"
          className={styles.dataToggle}
          aria-expanded={tableOpen}
          aria-controls={tableId}
          onClick={() => setTableOpen((open) => !open)}
        >
          {tableOpen ? 'Hide data table' : 'Show data table'}
        </button>

        {/* The readout follows the crosshair rather than living in a corner, so
            the eye does not have to travel to read what it is pointing at. */}
        {activeBar ? (
          <div className={styles.readout}>
            <span className={styles.readoutTime}>{formatTime(activeBar)}</span>
            <span>
              O <strong>{activeBar.open.toFixed(2)}</strong>
            </span>
            <span>
              H <strong>{activeBar.high.toFixed(2)}</strong>
            </span>
            <span>
              L <strong>{activeBar.low.toFixed(2)}</strong>
            </span>
            <span>
              C <strong>{activeBar.close.toFixed(2)}</strong>
            </span>
            {activeIndex !== undefined && isGhost(activeBar, activeIndex) ? (
              <span className={styles.ghostTag}>extended</span>
            ) : null}
          </div>
        ) : null}

        {loading && !bars.length ? <div className={styles.empty}>Loading…</div> : null}
        {!loading && !bars.length ? (
          <div className={styles.empty}>No bars for this symbol.</div>
        ) : null}
      </div>

      {tableOpen ? (
        <div id={tableId} className={styles.dataTable}>
          <table>
            <caption>
              {symbol} {timeframe} visible candle data. {visibleRange}
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Open</th>
                <th scope="col">High</th>
                <th scope="col">Low</th>
                <th scope="col">Close</th>
                <th scope="col">Volume</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map(({ bar }) => (
                <tr key={bar.time}>
                  <th scope="row">{formatTime(bar)}</th>
                  <td>{bar.open.toFixed(2)}</td>
                  <td>{bar.high.toFixed(2)}</td>
                  <td>{bar.low.toFixed(2)}</td>
                  <td>{bar.close.toFixed(2)}</td>
                  <td>{bar.volume.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

type DrawArgs = {
  bars: Bar[];
  window: IndexWindow;
  plot: { width: number; height: number };
  size: { width: number; height: number };
  isGhost: (bar: Bar, index: number) => boolean;
  formatTime: (bar: Bar) => string;
  layout: PaneLayout;
  indicators?: IndicatorSeries;
  position?: Position;
};

const COLOURS = {
  up: '#8dd36f',
  down: '#f08d78',
  grid: 'rgba(255, 255, 255, 0.06)',
  axis: '#b8aca0',
};

function drawChart(ctx: CanvasRenderingContext2D, args: DrawArgs): void {
  const { bars, window, plot, size, isGhost, formatTime, layout, indicators, position } = args;
  const shown = visibleBars(bars, window);
  if (!shown.length) return;

  // The price keeps the top band; the panes take what is left. Its band always
  // starts at zero, so the scale needs the height and no offset.
  const pricePlot = { width: plot.width, height: layout.price.height };
  const range = priceRange(shown);
  const scale = priceScale(range, pricePlot);
  const width = barWidth(window, plot);

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  for (const price of priceTicks(range, pricePlot)) {
    const y = scale(price);
    ctx.strokeStyle = COLOURS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Half-pixel so a one-pixel line lands on a pixel instead of straddling two.
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(plot.width, Math.round(y) + 0.5);
    ctx.stroke();

    ctx.fillStyle = COLOURS.axis;
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(2), plot.width + 6, y);
  }

  ctx.textAlign = 'center';
  for (const index of timeTicks(window, plot)) {
    const bar = bars[index];
    if (!bar) continue;
    const x = xAt(index, window, plot);

    ctx.strokeStyle = COLOURS.grid;
    ctx.beginPath();
    // Down the whole plot, so one vertical grid is shared by the price and
    // every pane and a bar lines up across all of them.
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, plot.height);
    ctx.stroke();

    ctx.fillStyle = COLOURS.axis;
    ctx.fillText(formatTime(bar), x, size.height - GUTTER_BOTTOM / 2);
  }

  // Under the candles: a moving average must never hide the bar that made it.
  if (indicators) {
    drawOverlays(ctx, { series: indicators, window, plot, band: layout.price, scale });
  }

  if (position) {
    drawPriceLines(ctx, {
      lines: [positionPriceLine(bars, position)],
      band: layout.price,
      plot,
      scale,
    });
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, layout.price.top, plot.width, layout.price.height);
  ctx.clip();

  const from = Math.max(0, Math.floor(window.first));
  for (let index = from; index < Math.min(bars.length, Math.ceil(window.last)); index += 1) {
    const bar = bars[index];
    if (!bar) continue;

    const x = xAt(index, window, plot);
    const rising = bar.close >= bar.open;
    // Extended-hours bars are drawn translucent rather than in another colour,
    // so up and down still read the same way outside the session.
    ctx.globalAlpha = isGhost(bar, index) ? 0.4 : 1;
    ctx.strokeStyle = rising ? COLOURS.up : COLOURS.down;
    ctx.fillStyle = ctx.strokeStyle;

    // The wick grows with the body; a hairline against a wide candle is the
    // thing that reads as broken when zoomed in.
    ctx.lineWidth = wickWidth(width);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, scale(bar.high));
    ctx.lineTo(Math.round(x) + 0.5, scale(bar.low));
    ctx.stroke();

    const top = scale(Math.max(bar.open, bar.close));
    const bottom = scale(Math.min(bar.open, bar.close));
    // A doji has no body to fill, so it gets a line rather than nothing at all.
    ctx.fillRect(x - width / 2, top, width, Math.max(1, bottom - top));
  }

  ctx.globalAlpha = 1;
  ctx.restore();

  if (indicators) {
    for (const pane of layout.panes) {
      drawPane(ctx, {
        id: pane.id,
        band: pane.band,
        series: indicators,
        window,
        plot,
        canvasWidth: size.width,
        rising: (index: number) => {
          const bar = bars[index];
          return bar ? bar.close >= bar.open : true;
        },
      });
    }
  }
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
  plot: { width: number; height: number },
  size: { width: number; height: number },
): void {
  ctx.strokeStyle = 'rgba(244, 238, 230, 0.35)';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(Math.round(at.x) + 0.5, 0);
  ctx.lineTo(Math.round(at.x) + 0.5, plot.height);
  ctx.moveTo(0, Math.round(at.y) + 0.5);
  ctx.lineTo(plot.width, Math.round(at.y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  void size;
}
