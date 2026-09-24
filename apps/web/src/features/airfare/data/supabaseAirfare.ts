/** Authenticated browser reads for the Pi-owned Airfare archive replica. */

import type {
  Airport,
  AirportMatch,
  FareCalendarResponse,
  FareHistoryResponse,
} from '@/shared/api/fares';
import { supabase } from '@/shared/supabase/client';
import type { Filters, Sort } from '@/features/airfare/lib/flightTable';
import { assembleHistory, HistoryRevisionChanged } from './airfareHistoryPages';
import {
  parseFareFlightPage,
  parseFareMonthProjection,
  type FareFlightPage,
  type FareMonthProjection,
} from './fareProjections';

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

export async function fetchFareMonthProjection(
  origin: string,
  destination: string,
  month: string,
  signal?: AbortSignal,
): Promise<FareMonthProjection | null> {
  const request = supabase.rpc('read_owner_fare_month_projection', {
    p_origin: origin,
    p_destination: destination,
    p_month: month,
  });
  const { data, error } = signal ? await request.abortSignal(signal) : await request;
  signal?.throwIfAborted();
  const value = rpcResult<unknown>(data, error);
  return value === null ? null : parseFareMonthProjection(value, origin, destination, month);
}

export async function fetchFareFlightPage(
  origin: string,
  destination: string,
  month: string,
  from: string,
  to: string,
  filters: Filters,
  sort: Sort,
  page: number,
  signal?: AbortSignal,
): Promise<FareFlightPage | null> {
  const request = supabase.rpc('read_owner_fare_flights_page', {
    p_origin: origin,
    p_destination: destination,
    p_month: month,
    p_from: from,
    p_to: to,
    p_filters: filters,
    p_sort: sort.column,
    p_direction: sort.direction,
    p_page: page,
    p_page_size: 10,
  });
  const { data, error } = signal ? await request.abortSignal(signal) : await request;
  signal?.throwIfAborted();
  const value = rpcResult<unknown>(data, error);
  return value === null ? null : parseFareFlightPage(value);
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
      if (error?.code === 'PT409' && error.message === 'airfare_history_revision_changed') {
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

export async function fetchAirports(
  codes: readonly string[] = [],
  options: { signal?: AbortSignal } = {},
): Promise<{ airports: Airport[] }> {
  const request = supabase.rpc('read_owner_fare_airports', { p_codes: [...codes] });
  const { data, error } = options.signal
    ? await request.abortSignal(options.signal)
    : await request;
  options.signal?.throwIfAborted();
  return rpcResult<{ airports: Airport[] }>(data, error);
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
