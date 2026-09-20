import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { supabase } from '@/shared/supabase/client';

export type AirfareRun = {
  status: string;
  started_at: string;
  completed_at: string | null;
  records_seen: number;
  records_written: number;
  records_failed: number;
  error_code: string | null;
};

export type AirfareRequestWorkerRun = {
  status: string;
  started_at: string;
  heartbeat_at: string;
};

export async function fetchLatestAirfareRun(): Promise<AirfareRun | null> {
  const { data, error } = await supabase
    .from('collector_runs')
    .select(
      'status, started_at, completed_at, records_seen, records_written, records_failed, error_code',
    )
    .eq('collector', 'airfare')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function useAirfareCollectorStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['collector-runs', 'airfare'],
    queryFn: fetchLatestAirfareRun,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    const channel = supabase
      .channel('airfare-collector-runs')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'collector_runs', filter: 'collector=eq.airfare' },
        () => {
          void client.invalidateQueries({ queryKey: ['collector-runs', 'airfare'] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [client]);
  return query;
}

export async function fetchLatestAirfareRequestWorkerRun(): Promise<AirfareRequestWorkerRun | null> {
  const { data, error } = await supabase
    .from('collector_runs')
    .select('status, started_at, heartbeat_at')
    .eq('collector', 'airfare-requests')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function airfareRequestWorkerHealthy(
  run: AirfareRequestWorkerRun | null | undefined,
  now = new Date(),
): boolean {
  if (!run || run.status !== 'running') return false;
  const startedAt = Date.parse(run.started_at);
  const heartbeatAt = Date.parse(run.heartbeat_at);
  const nowAt = now.getTime();
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(heartbeatAt) &&
    heartbeatAt > startedAt &&
    heartbeatAt <= nowAt &&
    nowAt - heartbeatAt <= 90_000
  );
}

export function useAirfareRequestWorkerStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['collector-runs', 'airfare-requests'],
    queryFn: fetchLatestAirfareRequestWorkerRun,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    const channel = supabase
      .channel('airfare-request-worker-runs')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'collector_runs',
          filter: 'collector=eq.airfare-requests',
        },
        () => {
          void client.invalidateQueries({ queryKey: ['collector-runs', 'airfare-requests'] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [client]);
  return query;
}

export function airfaresStatusText(run: AirfareRun | null | undefined): string {
  if (!run) return 'No Airfare run reported yet';
  if (run.status === 'running') return `Airfare collection running since ${run.started_at}.`;
  if (run.status === 'complete')
    return `Airfare collection completed ${run.completed_at ?? run.started_at}: ${run.records_seen} seen, ${run.records_written} written, ${run.records_failed} failed.`;
  if (run.status === 'failed')
    return `Airfare collection failed ${run.completed_at ?? run.started_at}${run.error_code ? ` (${run.error_code})` : ''}.`;
  return `Airfare collector status: ${run.status}.`;
}
