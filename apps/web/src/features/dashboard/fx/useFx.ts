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
    // Supabase supplies INITIAL_SESSION, then subsequent account changes. The
    // callback only changes React state; RPC reads run outside the auth lock.
    return subscribeToAuth((_event, session) => setOwnerId(session?.user.id ?? null));
  }, []);
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
  useEffect(() => {
    if (!ownerId) return;
    return () => {
      // Remove the previous owner's captures and cancel reads even if transport
      // completion arrives after sign-out or an account switch.
      void client.cancelQueries({ queryKey: ['fx', ownerId] });
      client.removeQueries({ queryKey: ['fx', ownerId] });
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
