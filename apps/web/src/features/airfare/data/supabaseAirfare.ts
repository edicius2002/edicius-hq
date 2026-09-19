/** Authenticated browser reads for the Pi-owned Airfare archive replica. */

import type { AirportMatch, FareCalendarResponse, FareHistoryResponse } from '@/shared/api/fares';
import { supabase } from '@/shared/supabase/client';
import { assembleHistory, HistoryRevisionChanged } from './airfareHistoryPages';

type HistoryOptions = {
  departure?: string;
  snapshotMonths?: readonly string[];
  since?: string;
  until?: string;
  signal?: AbortSignal;
};

function rpcResult<T>(data: unknown, error: unknown): T {
  if (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? ` (${error.code})`
        : '';
    throw new Error(`Airfare data request failed${code}.`);
  }
  return data as T;
}

export async function fetchFareHistory(
  origin: string,
  destination: string,
  options: HistoryOptions = {},
): Promise<FareHistoryResponse> {
  return assembleHistory(
    async (name, params, signal) => {
      const { data, error } = await supabase.rpc(name, params).abortSignal(signal);
      signal.throwIfAborted();
      if (error?.code === '40001' && error.message === 'airfare_history_revision_changed') {
        throw new HistoryRevisionChanged();
      }
      return rpcResult<unknown>(data, error);
    },
    {
      p_origin: origin,
      p_destination: destination,
      p_departure: options.departure ?? '',
      p_snapshot_months: [...(options.snapshotMonths ?? [])],
      p_since: options.since ?? '',
      p_until: options.until ?? '',
    },
    options.signal,
  );
}

export async function fetchFareCalendar(
  origin: string,
  destination: string,
): Promise<FareCalendarResponse> {
  const { data, error } = await supabase.rpc('read_owner_airfare_calendar', {
    p_origin: origin,
    p_destination: destination,
  });
  return rpcResult<FareCalendarResponse>(data, error);
}

export async function searchAirports(
  query: string,
  options: { limit?: number } = {},
): Promise<{ query: string; matches: AirportMatch[] }> {
  const { data, error } = await supabase.rpc('search_owner_airports', {
    p_query: query,
    p_limit: options.limit ?? 10,
  });
  return rpcResult<{ query: string; matches: AirportMatch[] }>(data, error);
}
