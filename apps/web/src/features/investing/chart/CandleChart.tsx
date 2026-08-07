import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';

import {
  barWidth,
  clampWindow,
  indexAt,
  panWindow,
  priceRange,
  priceScale,
  priceTicks,
  timeTicks,
  visibleBars,
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
  /** Whether a bar falls outside the regular session, and so draws translucent. */
  isGhost: (bar: Bar) => boolean;
  /** How to label a bar on the time axis; the chart does not own the calendar. */
  formatTime: (bar: Bar) => string;
  loading?: boolean;
};

type Crosshair = { x: number; y: number; index: number } | null;

export function CandleChart({ bars, isGhost, formatTime, loading }: CandleChartProps) {
  const [frameRef, size] = useElementSize<HTMLDivElement>();
  const candleRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [window, setWindow] = useState<IndexWindow>({ first: 0, last: DEFAULT_VISIBLE });
  const [crosshair, setCrosshair] = useState<Crosshair>(null);
  const [drag, setDrag] = useState<{ pointerId: number; x: number; from: IndexWindow } | null>(
    null,
  );
  // Set once per series so a reload lands on the latest bars rather than on the
  // oldest, while a refetch of the same series leaves the view where it was.
  const anchored = useRef<string>('');

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
    const key = `${bars.length}`;
    if (!bars.length || anchored.current === key) return;
    anchored.current = key;
    setWindow(
      clampWindow({ first: bars.length - DEFAULT_VISIBLE, last: bars.length }, bars.length),
    );
  }, [bars]);

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
    drawChart(ctx, { bars, window, plot, size, isGhost, formatTime });
  }, [bars, window, plot, size, isGhost, formatTime]);

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

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const { x, y } = pointerPosition(event);

    if (drag && event.pointerId === drag.pointerId) {
      const perBar = plot.width / Math.max(1, drag.from.last - drag.from.first);
      // Dragging right walks back through history, like moving a paper chart.
      setWindow(panWindow(drag.from, -(x - drag.x) / perBar, bars.length));
      return;
    }

    if (x > plot.width || y > plot.height) {
      setCrosshair(null);
      return;
    }
    setCrosshair({ x, y, index: Math.round(indexAt(x, window, plot)) });
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const pivot = indexAt(event.clientX - rect.left, window, plot);
    setWindow(
      zoomWindow(window, event.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP, pivot, bars.length),
    );
  }

  const hovered = crosshair ? bars[crosshair.index] : undefined;

  return (
    <div className={styles.chart} ref={frameRef}>
      <canvas ref={candleRef} className={styles.layer} style={{ width: '100%', height: '100%' }} />
      <canvas ref={overlayRef} className={styles.layer} style={{ width: '100%', height: '100%' }} />

      <div
        className={`${styles.surface} ${drag ? styles.dragging : ''}`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag({ pointerId: event.pointerId, x: pointerPosition(event).x, from: window });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setCrosshair(null)}
        onWheel={onWheel}
      />

      {/* The readout follows the crosshair rather than living in a corner, so
          the eye does not have to travel to read what it is pointing at. */}
      {hovered ? (
        <div className={styles.readout}>
          <span className={styles.readoutTime}>{formatTime(hovered)}</span>
          <span>
            O <strong>{hovered.open.toFixed(2)}</strong>
          </span>
          <span>
            H <strong>{hovered.high.toFixed(2)}</strong>
          </span>
          <span>
            L <strong>{hovered.low.toFixed(2)}</strong>
          </span>
          <span>
            C <strong>{hovered.close.toFixed(2)}</strong>
          </span>
          {isGhost(hovered) ? <span className={styles.ghostTag}>extended</span> : null}
        </div>
      ) : null}

      {loading && !bars.length ? <div className={styles.empty}>Loading…</div> : null}
      {!loading && !bars.length ? (
        <div className={styles.empty}>No bars for this symbol.</div>
      ) : null}
    </div>
  );
}

type DrawArgs = {
  bars: Bar[];
  window: IndexWindow;
  plot: { width: number; height: number };
  size: { width: number; height: number };
  isGhost: (bar: Bar) => boolean;
  formatTime: (bar: Bar) => string;
};

const COLOURS = {
  up: '#8dd36f',
  down: '#f08d78',
  grid: 'rgba(255, 255, 255, 0.06)',
  axis: '#b8aca0',
};

function drawChart(ctx: CanvasRenderingContext2D, args: DrawArgs): void {
  const { bars, window, plot, size, isGhost, formatTime } = args;
  const shown = visibleBars(bars, window);
  if (!shown.length) return;

  const range = priceRange(shown);
  const scale = priceScale(range, plot);
  const width = barWidth(window, plot);

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  for (const price of priceTicks(range, plot)) {
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
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, plot.height);
    ctx.stroke();

    ctx.fillStyle = COLOURS.axis;
    ctx.fillText(formatTime(bar), x, size.height - GUTTER_BOTTOM / 2);
  }

  const from = Math.max(0, Math.floor(window.first));
  for (let index = from; index < Math.min(bars.length, Math.ceil(window.last)); index += 1) {
    const bar = bars[index];
    if (!bar) continue;

    const x = xAt(index, window, plot);
    const rising = bar.close >= bar.open;
    // Extended-hours bars are drawn translucent rather than in another colour,
    // so up and down still read the same way outside the session.
    ctx.globalAlpha = isGhost(bar) ? 0.4 : 1;
    ctx.strokeStyle = rising ? COLOURS.up : COLOURS.down;
    ctx.fillStyle = ctx.strokeStyle;

    ctx.lineWidth = 1;
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
