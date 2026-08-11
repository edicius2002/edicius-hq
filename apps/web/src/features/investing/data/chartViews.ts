import type { IndexWindow } from '@/features/investing/lib/scales';
import type { StorageKey } from '@/shared/storage/keys';

/** The chart window is personal view state, separate from positions and drawings. */
export const CHART_VIEWS_KEY: StorageKey = 'chart-views';

export type ChartViews = {
  version: 1;
  /** One x-axis window per instrument and timeframe, keyed by `chartViewKey`. */
  windows: Record<string, IndexWindow>;
};

export const NO_CHART_VIEWS: ChartViews = { version: 1, windows: {} };

function isIndexWindow(value: unknown): value is IndexWindow {
  if (!value || typeof value !== 'object') return false;
  const { first, last } = value as Record<string, unknown>;
  return (
    typeof first === 'number' &&
    Number.isFinite(first) &&
    first >= 0 &&
    typeof last === 'number' &&
    Number.isFinite(last) &&
    last > first
  );
}

/**
 * A saved index range is intentionally validated but not clamped here: bar
 * counts change as a provider rolls history forward, and only the chart knows
 * the series length it must fit inside.
 */
export function normalizeChartViews(value: unknown): ChartViews {
  if (!value || typeof value !== 'object') return NO_CHART_VIEWS;

  const raw = (value as { windows?: unknown }).windows;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_CHART_VIEWS;

  const windows: Record<string, IndexWindow> = {};
  for (const [key, window] of Object.entries(raw)) {
    if (!key || !isIndexWindow(window)) continue;
    windows[key] = { first: window.first, last: window.last };
  }

  return { version: 1, windows };
}

/** A stable storage key for the one chart surface that can be viewing this series. */
export function chartViewKey(symbol: string, timeframe: string): string {
  return `${symbol.trim().toUpperCase()}:${timeframe}`;
}

/** Save only a material move, so a repeated wheel event at an edge costs nothing. */
export function setChartWindow(
  views: ChartViews,
  key: string,
  window: IndexWindow,
): ChartViews {
  const previous = views.windows[key];
  if (previous?.first === window.first && previous.last === window.last) return views;

  return { version: 1, windows: { ...views.windows, [key]: window } };
}
