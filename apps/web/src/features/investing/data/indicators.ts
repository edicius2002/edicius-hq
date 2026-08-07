/**
 * Which indicators are on, as a stored document.
 *
 * Global rather than per symbol: if you follow RSI, you follow it everywhere,
 * and per-symbol state would need a rule for what a newly added symbol
 * inherits — a rule with no obviously right answer. Decision 8.22.
 *
 * The legacy kept this in memory only, so every reload lost it. That is the one
 * behaviour here deliberately not carried over.
 */

export const INDICATORS_KEY = 'indicators';

/** Overlays draw on the price; panes get a band of their own below it. */
export const OVERLAY_IDS = ['sma', 'ema', 'bollinger', 'vwap'] as const;
export const PANE_IDS = ['rsi', 'macd'] as const;

export type OverlayId = (typeof OVERLAY_IDS)[number];
export type IndicatorId = OverlayId | (typeof PANE_IDS)[number];

export const INDICATOR_IDS: IndicatorId[] = [...OVERLAY_IDS, ...PANE_IDS];

export type Indicators = {
  version: 1;
  active: IndicatorId[];
};

/** Nothing on. A chart that opened covered in lines would be a worse default. */
export const NO_INDICATORS: Indicators = { version: 1, active: [] };

/**
 * Reads whatever storage had into something this version understands.
 *
 * Unknown ids are dropped rather than kept: they would be drawn by nothing and
 * would silently come back if an id were ever reused for something else.
 */
export function normalizeIndicators(value: unknown): Indicators {
  if (!value || typeof value !== 'object') return NO_INDICATORS;

  const raw = (value as { active?: unknown }).active;
  if (!Array.isArray(raw)) return NO_INDICATORS;

  const active = INDICATOR_IDS.filter((id) => raw.includes(id));
  return { version: 1, active };
}

export function isActive(indicators: Indicators, id: IndicatorId): boolean {
  return indicators.active.includes(id);
}

/** Toggling keeps the canonical order, so the stored list never depends on clicks. */
export function toggle(indicators: Indicators, id: IndicatorId): Indicators {
  const wanted = new Set(indicators.active);
  if (wanted.has(id)) wanted.delete(id);
  else wanted.add(id);

  return { version: 1, active: INDICATOR_IDS.filter((each) => wanted.has(each)) };
}

export function activePanes(indicators: Indicators): ('rsi' | 'macd')[] {
  return PANE_IDS.filter((id) => indicators.active.includes(id));
}
