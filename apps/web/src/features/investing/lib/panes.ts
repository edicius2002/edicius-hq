/**
 * How the chart's vertical space is divided between the price and the panes.
 *
 * The legacy gave RSI and MACD their own chart instances and then spent most of
 * `chart-ta.js` keeping three of them agreeing about the pointer. Here a pane is
 * a band of the same canvas: it shares the camera, the bar index and the
 * crosshair by construction, so there is nothing to synchronise. All this file
 * has to answer is where each band starts and how tall it is.
 */

export type PaneId = 'rsi' | 'macd';

export type Band = {
  /** Distance from the top of the plot area, in CSS pixels. */
  top: number;
  height: number;
};

export type PaneLayout = {
  price: Band;
  panes: { id: PaneId; band: Band }[];
};

/** The order panes appear in, whichever subset is on. */
export const PANE_ORDER: PaneId[] = ['rsi', 'macd'];

/** Share of the plot each pane takes, leaving the rest to the price. */
const PANE_SHARE = 0.2;

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
  while (showing.length && !fits(height, showing.length)) {
    showing = showing.slice(0, -1);
  }

  if (!showing.length) {
    return { price: { top: 0, height: Math.max(0, height) }, panes: [] };
  }

  const paneHeight = Math.max(MIN_PANE_HEIGHT, height * PANE_SHARE);
  const taken = showing.length * (paneHeight + PANE_GAP);

  const panes = showing.map((id, index) => ({
    id,
    band: {
      top: height - taken + index * (paneHeight + PANE_GAP) + PANE_GAP,
      height: paneHeight,
    },
  }));

  return { price: { top: 0, height: height - taken }, panes };
}

function fits(height: number, count: number): boolean {
  const paneHeight = Math.max(MIN_PANE_HEIGHT, height * PANE_SHARE);
  return height - count * (paneHeight + PANE_GAP) >= MIN_PRICE_HEIGHT;
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
