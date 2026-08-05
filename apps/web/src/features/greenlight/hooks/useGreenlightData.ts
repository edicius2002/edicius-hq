import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  EMPTY_GREENLIGHT_STATE,
  type GreenlightState,
  type ReplaceMode,
} from '@/features/greenlight/model/types';
import { readStorage, writeStorage } from '@/shared/storage/storage';

const QUERY_KEY = ['storage', 'greenlight'] as const;

function normalizeState(value: GreenlightState | null): GreenlightState {
  if (!value || typeof value !== 'object') return EMPTY_GREENLIGHT_STATE;
  return {
    stats: value.stats && typeof value.stats === 'object' ? value.stats : {},
    meta: value.meta ?? null,
    markers: Array.isArray(value.markers) ? value.markers : [],
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

  const importMutation = useMutation({
    mutationFn: async ({
      fileName,
      content,
      replaceMode,
    }: {
      fileName: string;
      content: string;
      replaceMode: ReplaceMode;
    }) => {
      const current = normalizeState(queryClient.getQueryData<GreenlightState>(QUERY_KEY) ?? null);
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

      const next: GreenlightState = {
        stats,
        markers: current.markers,
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
      return persist(next);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => persist(EMPTY_GREENLIGHT_STATE),
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
    },
  });

  const sampleMutation = useMutation({
    mutationFn: async () => {
      const { createSampleGreenlightState } = await import('@/features/greenlight/lib/sampleData');
      return persist(createSampleGreenlightState());
    },
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
    },
  });

  const markersMutation = useMutation({
    mutationFn: async (markers: string[]) => {
      const current = normalizeState(queryClient.getQueryData<GreenlightState>(QUERY_KEY) ?? null);
      return persist({ ...current, markers });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
    },
  });

  return {
    state: normalizeState(query.data ?? null),
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    importCsv: importMutation.mutateAsync,
    isImporting: importMutation.isPending,
    importError: importMutation.error,
    clearData: clearMutation.mutateAsync,
    isClearing: clearMutation.isPending,
    loadSample: sampleMutation.mutateAsync,
    isLoadingSample: sampleMutation.isPending,
    setMarkers: markersMutation.mutateAsync,
    isUpdatingMarkers: markersMutation.isPending,
    reload: () => query.refetch(),
  };
}
