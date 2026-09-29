import { useQuery } from '@tanstack/react-query';
import { fetchLatest, fetchHistory } from './data';
import type { Source, Range } from './sources';
export function useFx(source: Source, range: Range) {
  const latest = useQuery({
    queryKey: ['fx', 'latest'],
    queryFn: ({ signal }) => fetchLatest(signal),
    refetchInterval: 60_000,
  });
  const history = useQuery({
    queryKey: ['fx', 'history', source, range],
    queryFn: ({ signal }) => fetchHistory(source, range, signal),
    refetchInterval: 60_000,
  });
  return { latest, history };
}
