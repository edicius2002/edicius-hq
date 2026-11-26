import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subscribeToAuth } from '@/shared/auth/supabaseAuth';
import { fetchLatest, fetchHistory, subscribeFxObservations } from './data';
import type { Source, Range } from './sources';
import type { Observation } from './types';

const CHANGE_BURST_MS = 250;
const QUOTE_INTERVAL_MS = 5_000;
const HISTORY_INTERVAL_MS = 60_000;

export function useFx(source: Source, range: Range) {
  const client = useQueryClient();
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const previousQuotes = useRef<{ ownerId: string; rows: Observation[] } | null>(null);
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
        // Changed captures refresh history through the same path as polling.
        // The minute reconciliation also picks up older historical revisions.
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
    staleTime: QUOTE_INTERVAL_MS,
    refetchInterval: QUOTE_INTERVAL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const history = useQuery({
    queryKey: ['fx', ownerId, 'history', source, range],
    enabled: ownerId !== null,
    queryFn: ({ signal }) => {
      if (!ownerId) throw new Error('An authenticated owner is required for FX reads');
      return fetchHistory(source, range, signal);
    },
    staleTime: HISTORY_INTERVAL_MS,
    refetchInterval: HISTORY_INTERVAL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  useEffect(() => {
    if (!ownerId || !latest.data) {
      previousQuotes.current = null;
      return;
    }
    const previous = previousQuotes.current;
    previousQuotes.current = { ownerId, rows: latest.data };
    if (previous?.ownerId !== ownerId) return;
    // React Query preserves equal rows by structural sharing. A new capture,
    // corrected price/context or removed source invalidates only its histories.
    const sources = new Set([...previous.rows, ...latest.data].map((row) => row.source));
    for (const changedSource of sources) {
      if (
        previous.rows.find((row) => row.source === changedSource) !==
        latest.data.find((row) => row.source === changedSource)
      ) {
        void client.invalidateQueries({ queryKey: ['fx', ownerId, 'history', changedSource] });
      }
    }
  }, [client, latest.data, ownerId]);
  return { latest, history };
}
