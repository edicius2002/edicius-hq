/**
 * How the chart's vertical space is divided between the price and the panes.
 *
 * The legacy gave RSI and MACD their own chart instances and then spent most of
 * `chart-ta.js` keeping three of them agreeing about the pointer. Here a pane is
 * a band of the same canvas: it shares the camera, the bar index and the
 * crosshair by construction, so there is nothing to synchronise. All this file
 * has to answer is where each band starts and how tall it is.
 */

export type PaneId = 'volume' | 'rsi' | 'macd';

export type Band = {
  /** Distance from the top of the plot area, in CSS pixels. */
  top: number;
  height: number;
};

export type PaneLayout = {
  price: Band;
  panes: { id: PaneId; band: Band }[];
};

/**
 * The order panes appear in, whichever subset is on.
 *
 * Volume sits directly under the price, which is where every terminal puts it:
 * it is a property of the same bars rather than a study derived from them, and
 * reading it means glancing down from the candle, not past two other panes.
 */
export const PANE_ORDER: PaneId[] = ['volume', 'rsi', 'macd'];

/** Share of the plot each pane takes, leaving the rest to the price. */
const PANE_SHARE = 0.2;

/** Volume is a texture under the price, not a study; it needs less room. */
const VOLUME_SHARE = 0.13;

/**
 * Below this a pane is a smear rather than a reading, so it is not drawn at
 * all. Silently squeezing three bands into a short chart would produce three
 * unreadable ones instead of one readable one.
 */
export const MIN_PANE_HEIGHT = 56;
export const MIN_PRICE_HEIGHT = 120;

/** A hairline between bands, so a pane reads as its own region. */
export const PANE_GAP = 1;

export function layoutPanes(height: number, active: PaneId[]): PaneLayout {
  const wanted = PANE_ORDER.filter((id) => active.includes(id));

  // Take panes off the end until what is left fits. Dropping the last is the
  // predictable choice: the price keeps its floor and the order never shuffles.
  let showing = wanted;
  while (showing.length && !fits(height, showing)) {
    showing = showing.slice(0, -1);
  }

  if (!showing.length) {
    return { price: { top: 0, height: Math.max(0, height) }, panes: [] };
  }

  const heights = showing.map((id) => paneHeightFor(height, id));
  const taken = heights.reduce((sum, each) => sum + each + PANE_GAP, 0);

  let cursor = height - taken + PANE_GAP;
  const panes = showing.map((id, index) => {
    const band = { top: cursor, height: heights[index] };
    cursor += heights[index] + PANE_GAP;
    return { id, band };
  });

  return { price: { top: 0, height: height - taken }, panes };
}

function paneHeightFor(height: number, id: PaneId): number {
  const share = id === 'volume' ? VOLUME_SHARE : PANE_SHARE;
  return Math.max(MIN_PANE_HEIGHT, height * share);
}

/**
 * Measured over the panes actually being shown, not the first n of the global
 * order: they take different heights, so asking about the wrong ones would fit
 * a volume band where a MACD is going to be drawn.
 */
function fits(height: number, showing: PaneId[]): boolean {
  const taken = showing.reduce((sum, id) => sum + paneHeightFor(height, id) + PANE_GAP, 0);
  return height - taken >= MIN_PRICE_HEIGHT;
}

/** Which band a y coordinate falls in, or null in the gap between two. */
export function bandAt(layout: PaneLayout, y: number): 'price' | PaneId | null {
  if (within(layout.price, y)) return 'price';
  for (const pane of layout.panes) if (within(pane.band, y)) return pane.id;
  return null;
}

function within(band: Band, y: number): boolean {
  return y >= band.top && y < band.top + band.height;
}

/** Maps a value onto a band, top-down, the way a canvas measures. */
export function valueToY(value: number, band: Band, low: number, high: number): number {
  const span = high - low || 1;
  return band.top + band.height - ((value - low) / span) * band.height;
}
