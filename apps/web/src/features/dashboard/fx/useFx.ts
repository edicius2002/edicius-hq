import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subscribeToAuth } from '@/shared/auth/supabaseAuth';
import { fetchLatest, fetchHistory, subscribeFxObservations } from './data';
import type { Source, Range } from './sources';

const CHANGE_BURST_MS = 250;

export function useFx(source: Source, range: Range) {
  const client = useQueryClient();
  const [ownerId, setOwnerId] = useState<string | null>(null);
  useEffect(() => {
    let previousOwner: string | null = null;
    return subscribeToAuth((_event, session) => {
      const nextOwner = session?.user.id ?? null;
      if (previousOwner && previousOwner !== nextOwner) {
        void client.cancelQueries({ queryKey: ['fx', previousOwner] });
        client.removeQueries({ queryKey: ['fx', previousOwner] });
      }
      previousOwner = nextOwner;
      setOwnerId(nextOwner);
    });
  }, [client]);
  useEffect(() => {
    if (!ownerId) return;
    // One collector pass upserts a row per source (thousands during a backfill)
    // and Realtime delivers each separately; refresh once per burst instead.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFxObservations(ownerId, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: ['fx', ownerId, 'latest'] });
        void client.invalidateQueries({ queryKey: ['fx', ownerId, 'history'] });
      }, CHANGE_BURST_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, ownerId]);

  const latest = useQuery({
    queryKey: ['fx', ownerId, 'latest'],
    enabled: ownerId !== null,
    queryFn: ({ signal }) => {
      // refetch() can bypass enabled, so imperative refresh must also be gated.
      if (!ownerId) throw new Error('An authenticated owner is required for FX reads');
      return fetchLatest(signal);
    },
    refetchInterval: 60_000,
  });
  const history = useQuery({
    queryKey: ['fx', ownerId, 'history', source, range],
    enabled: ownerId !== null,
    queryFn: ({ signal }) => {
      if (!ownerId) throw new Error('An authenticated owner is required for FX reads');
      return fetchHistory(source, range, signal);
    },
    refetchInterval: 60_000,
  });
  return { latest, history };
}
