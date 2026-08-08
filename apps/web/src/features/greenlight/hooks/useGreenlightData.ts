import { useMutation } from '@tanstack/react-query';

import {
  mergeDetectedWidgets,
  normalizeToolWidgets,
  toggleToolWidget,
} from '@/features/greenlight/lib/subscriptions';
import {
  EMPTY_GREENLIGHT_STATE,
  type DayStats,
  type GreenlightState,
  type ReplaceMode,
  type ToolId,
} from '@/features/greenlight/model/types';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * One day, or nothing.
 *
 * `stats` used to be accepted whole on `typeof === 'object'`, so a single
 * malformed day reached `toDayRows`, which reads `day.Deliverable.amount`
 * unguarded. That throws, and the boundary that catches it wraps the entire
 * `RouterProvider` — the app is replaced by an error screen with no navigation,
 * so there is no route to the Clear button that would have fixed it. One bad
 * byte and the way out is gone.
 *
 * A day that cannot be read is dropped rather than repaired, for the same
 * reason Finance's `toNode` and the portfolio's normalizer drop rather than
 * guess: losing a day is visible, and an invented one is not.
 */
function toDayStats(value: unknown): DayStats | null {
  if (!value || typeof value !== 'object') return null;
  const day = value as Partial<DayStats>;

  // The amount is the one field with no sensible stand-in, so it decides.
  const amount = day.Deliverable?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;

  return {
    Deliverable: {
      amount,
      details: Array.isArray(day.Deliverable?.details) ? day.Deliverable.details : [],
    },
    currency: typeof day.currency === 'string' && day.currency ? day.currency : 'USD',
  };
}

function normalizeStats(value: unknown): Record<string, DayStats> {
  if (!value || typeof value !== 'object') return {};

  const stats: Record<string, DayStats> = {};
  for (const [date, day] of Object.entries(value as Record<string, unknown>)) {
    const usable = toDayStats(day);
    if (usable) stats[date] = usable;
  }
  return stats;
}

function normalizeState(value: unknown): GreenlightState {
  if (!value || typeof value !== 'object') return EMPTY_GREENLIGHT_STATE;
  const stored = value as Partial<GreenlightState>;
  return {
    stats: normalizeStats(stored.stats),
    meta: stored.meta ?? null,
    markers: Array.isArray(stored.markers)
      ? stored.markers.filter((marker) => typeof marker === 'string')
      : [],
    widgets: normalizeToolWidgets(stored.widgets),
  };
}

export function useGreenlightData() {
  // Write serialization, the debounce in front of it and the refusal to save
  // over a failed read all live in the shared store, so Greenlight and Finance
  // cannot drift apart on any of them.
  const store = useStoredDocument<GreenlightState>({
    key: 'greenlight',
    normalize: normalizeState,
    placeholder: EMPTY_GREENLIGHT_STATE,
  });

  const importMutation = useMutation({
    mutationFn: ({
      fileName,
      content,
      replaceMode,
    }: {
      fileName: string;
      content: string;
      replaceMode: ReplaceMode;
    }) =>
      store.edit(async (current) => {
        const { importGreenlightCsv } = await import('@/features/greenlight/lib/processRows');
        const imported = importGreenlightCsv(content);

        let stats = imported.stats;
        let statusDetail = `Replaced all data with ${imported.daysGenerated} day(s) from ${imported.rowsRead} rows.`;

        if (replaceMode === 'current-month') {
          const { currentMonthKey, mergeCurrentMonthStats } =
            await import('@/features/greenlight/lib/merge');
          const monthKey = currentMonthKey();
          const { merged, replacedDays } = mergeCurrentMonthStats(
            current.stats,
            imported.stats,
            monthKey,
          );
          stats = merged;
          statusDetail =
            `Replaced only ${monthKey}: ${replacedDays} day(s) from the CSV. ` +
            'Other months were kept; unmarked CSV days outside this month were ignored.';
        }

        return {
          stats,
          markers: current.markers,
          widgets: mergeDetectedWidgets(current.widgets, imported.widgets),
          meta: {
            fileName,
            rowsRead: imported.rowsRead,
            daysGenerated: Object.keys(stats).length,
            replaceMode,
            updatedAt: new Date().toISOString(),
            statusTitle: 'Updated from CSV',
            statusDetail: `${statusDetail} Markers were kept.`,
          },
        };
      }),
  });

  const clearMutation = useMutation({
    mutationFn: () => store.replace(EMPTY_GREENLIGHT_STATE),
  });

  // Toggles take the intent, not a precomputed array: the new value has to be
  // derived inside the write from state the caller's render may not have seen.
  const toggleMarkerMutation = useMutation({
    mutationFn: (dayKey: string) =>
      store.edit((current) => ({
        ...current,
        markers: current.markers.includes(dayKey)
          ? current.markers.filter((day) => day !== dayKey)
          : [...current.markers, dayKey],
      })),
  });

  const clearMarkersMutation = useMutation({
    mutationFn: () => store.edit((current) => ({ ...current, markers: [] })),
  });

  const toggleWidgetMutation = useMutation({
    mutationFn: ({ monthKey, tool }: { monthKey: string; tool: ToolId }) =>
      store.edit((current) => ({
        ...current,
        widgets: toggleToolWidget(current.widgets, monthKey, tool),
      })),
  });

  return {
    state: store.data,
    isFetching: store.isFetching,
    isError: store.isError,
    saveState: store.saveState,
    retrySave: store.retrySave,
    importCsv: importMutation.mutateAsync,
    isImporting: importMutation.isPending,
    clearData: clearMutation.mutateAsync,
    isClearing: clearMutation.isPending,
    toggleMarker: toggleMarkerMutation.mutateAsync,
    clearMarkers: clearMarkersMutation.mutateAsync,
    toggleWidget: toggleWidgetMutation.mutateAsync,
  };
}
