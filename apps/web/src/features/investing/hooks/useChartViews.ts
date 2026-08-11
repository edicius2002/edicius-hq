import { useCallback } from 'react';

import {
  CHART_VIEWS_KEY,
  NO_CHART_VIEWS,
  normalizeChartViews,
  setChartWindow,
  type ChartViews,
} from '@/features/investing/data/chartViews';
import type { IndexWindow } from '@/features/investing/lib/scales';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/** The last viewport per chart, kept outside market data and the portfolio. */
export function useChartViews() {
  const store = useStoredDocument<ChartViews>({
    key: CHART_VIEWS_KEY,
    normalize: normalizeChartViews,
    placeholder: NO_CHART_VIEWS,
  });

  const setWindow = useCallback(
    (key: string, window: IndexWindow) =>
      store.edit((current) => setChartWindow(current, key, window)),
    [store],
  );

  return {
    windows: store.data.windows,
    isFetching: store.isFetching,
    isError: store.isError,
    setWindow,
  };
}
