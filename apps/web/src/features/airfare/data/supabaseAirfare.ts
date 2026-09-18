/** Authenticated browser reads for the Pi-owned Airfare archive replica. */

import type { AirportMatch, FareCalendarResponse, FareHistoryResponse } from '@/shared/api/fares';
import { supabase } from '@/shared/supabase/client';

type HistoryOptions = {
  departure?: string;
  snapshotMonths?: readonly string[];
  since?: string;
  until?: string;
};

function rpcResult<T>(data: unknown, error: unknown): T {
  if (error) throw error;
  return data as T;
}

export async function fetchFareHistory(
  origin: string,
  destination: string,
  options: HistoryOptions = {},
): Promise<FareHistoryResponse> {
  const { data, error } = await supabase.rpc('read_owner_airfare_history', {
    p_origin: origin,
    p_destination: destination,
    p_departure: options.departure ?? '',
    p_snapshot_months: [...(options.snapshotMonths ?? [])],
    p_since: options.since ?? '',
    p_until: options.until ?? '',
  });
  return rpcResult<FareHistoryResponse>(data, error);
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
