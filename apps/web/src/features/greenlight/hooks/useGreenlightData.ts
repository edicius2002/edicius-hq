import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import { EMPTY_GREENLIGHT_STATE, type GreenlightState } from '@/features/greenlight/model/types';
import { readStorage, writeStorage } from '@/shared/storage/storage';

const QUERY_KEY = ['storage', 'greenlight'] as const;

export function useGreenlightData() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) =>
      readStorage<GreenlightState>('greenlight', signal).then((v) => v ?? EMPTY_GREENLIGHT_STATE),
  });

  const importMutation = useMutation({
    mutationFn: async ({ fileName, content }: { fileName: string; content: string }) => {
      const imported = importGreenlightCsv(content);
      const next: GreenlightState = {
        stats: imported.stats,
        meta: {
          fileName,
          rowsRead: imported.rowsRead,
          daysGenerated: imported.daysGenerated,
          updatedAt: new Date().toISOString(),
        },
      };
      await writeStorage('greenlight', next);
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      await writeStorage('greenlight', EMPTY_GREENLIGHT_STATE);
      return EMPTY_GREENLIGHT_STATE;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
    },
  });

  return {
    state: query.data ?? EMPTY_GREENLIGHT_STATE,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    importCsv: importMutation.mutateAsync,
    isImporting: importMutation.isPending,
    importError: importMutation.error,
    clearData: clearMutation.mutateAsync,
    isClearing: clearMutation.isPending,
    reload: () => query.refetch(),
  };
}
