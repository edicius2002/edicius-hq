import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import {
  mergeDetectedWidgets,
  normalizeToolWidgets,
  toggleToolWidget,
} from '@/features/greenlight/lib/subscriptions';
import {
  EMPTY_GREENLIGHT_STATE,
  type GreenlightState,
  type ReplaceMode,
  type ToolId,
} from '@/features/greenlight/model/types';
import { readStorage, writeStorage } from '@/shared/storage/storage';

const QUERY_KEY = ['storage', 'greenlight'] as const;

const noop = () => undefined;

function normalizeState(value: GreenlightState | null): GreenlightState {
  if (!value || typeof value !== 'object') return EMPTY_GREENLIGHT_STATE;
  return {
    stats: value.stats && typeof value.stats === 'object' ? value.stats : {},
    meta: value.meta ?? null,
    markers: Array.isArray(value.markers) ? value.markers : [],
    widgets: normalizeToolWidgets(value.widgets),
  };
}

async function persist(next: GreenlightState): Promise<GreenlightState> {
  await writeStorage('greenlight', next);
  return next;
}

export function useGreenlightData() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) =>
      readStorage<GreenlightState>('greenlight', signal).then(normalizeState),
    placeholderData: EMPTY_GREENLIGHT_STATE,
    retry: false,
  });

  /**
   * Base state for a write. `placeholderData` never reaches the cache, so an
   * undefined entry means the read failed rather than "stored document is empty"
   * — a missing key still resolves to EMPTY_GREENLIGHT_STATE. Editing on top of
   * a failed read would PUT an empty document over real stored data.
   */
  function readBaseState(): GreenlightState {
    const cached = queryClient.getQueryData<GreenlightState>(QUERY_KEY);
    if (!cached) {
      throw new Error('Greenlight data could not be loaded, so nothing was saved. Reload first.');
    }
    return normalizeState(cached);
  }

  /**
   * Every write is read-modify-write over the whole document, so overlapping
   * writes would build the second edit from pre-first-write state and silently
   * drop the first. This chain runs them strictly one at a time; because each
   * task refreshes the cache before resolving, the next one reads current state.
   * A failed write does not break the chain for later writes.
   */
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());

  function serializeWrite(task: () => Promise<GreenlightState>): Promise<GreenlightState> {
    const run = writeChain.current.then(task, task);
    writeChain.current = run.then(noop, noop);
    return run;
  }

  /** Persist and refresh the cache inside the serialized task, never after it. */
  async function commit(next: GreenlightState): Promise<GreenlightState> {
    await persist(next);
    queryClient.setQueryData(QUERY_KEY, next);
    return next;
  }

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
      serializeWrite(async () => {
        const current = readBaseState();
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

        return commit({
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
        });
      }),
  });

  const clearMutation = useMutation({
    mutationFn: () => serializeWrite(() => commit(EMPTY_GREENLIGHT_STATE)),
  });

  // Toggles take the intent, not a precomputed array: the new value has to be
  // derived inside the write from state the caller's render may not have seen.
  const toggleMarkerMutation = useMutation({
    mutationFn: (dayKey: string) =>
      serializeWrite(async () => {
        const current = readBaseState();
        const markers = current.markers.includes(dayKey)
          ? current.markers.filter((day) => day !== dayKey)
          : [...current.markers, dayKey];
        return commit({ ...current, markers });
      }),
  });

  const clearMarkersMutation = useMutation({
    mutationFn: () => serializeWrite(async () => commit({ ...readBaseState(), markers: [] })),
  });

  const toggleWidgetMutation = useMutation({
    mutationFn: ({ monthKey, tool }: { monthKey: string; tool: ToolId }) =>
      serializeWrite(async () => {
        const current = readBaseState();
        return commit({ ...current, widgets: toggleToolWidget(current.widgets, monthKey, tool) });
      }),
  });

  return {
    state: normalizeState(query.data ?? null),
    isFetching: query.isFetching,
    isError: query.isError,
    importCsv: importMutation.mutateAsync,
    isImporting: importMutation.isPending,
    clearData: clearMutation.mutateAsync,
    isClearing: clearMutation.isPending,
    toggleMarker: toggleMarkerMutation.mutateAsync,
    clearMarkers: clearMarkersMutation.mutateAsync,
    toggleWidget: toggleWidgetMutation.mutateAsync,
  };
}
