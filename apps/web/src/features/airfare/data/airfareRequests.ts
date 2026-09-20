import { supabase } from '@/shared/supabase/client';

const OPERATION = 'airfare-route';
const REQUEST_STATUSES = ['queued', 'running', 'complete', 'failed', 'expired'] as const;
const PROGRESS_STAGES = ['queued', 'collecting', 'syncing'] as const;
const ERROR_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type AirfareRequestInput = {
  origin: string;
  destination: string;
  month: string;
  currency: string;
};

export type AirfareRequestProgress = {
  stage: (typeof PROGRESS_STAGES)[number];
  completed: number;
  total: number | null;
};

export type AirfareRequestResult = {
  origin: string;
  destination: string;
  month: string;
  lookedAt: number;
  changed: number;
  failed: number;
  skipped: number;
  synced: true;
};

export type AirfareRequest = {
  requestId: string;
  payload: AirfareRequestInput;
  progress: AirfareRequestProgress;
  status: (typeof REQUEST_STATUSES)[number];
  result: AirfareRequestResult | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
};

export class AirfareRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'AirfareRequestError';
    this.code = code;
  }
}

export async function enqueueAirfareRequest(input: AirfareRequestInput): Promise<AirfareRequest> {
  const { data, error } = await supabase.rpc('enqueue_airfare_route_request', {
    p_origin: input.origin.trim().toUpperCase(),
    p_destination: input.destination.trim().toUpperCase(),
    p_month: input.month.trim(),
    p_currency: input.currency.trim().toUpperCase(),
  });
  if (error || !data) throw new AirfareRequestError('request_unavailable');
  return decodeAirfareRequest(data);
}

export async function fetchActiveAirfareRequests(): Promise<AirfareRequest[]> {
  const { data, error } = await supabase
    .from('collector_requests')
    .select(requestColumns)
    .eq('operation', OPERATION)
    .in('status', ['queued', 'running'])
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });
  if (error) throw new AirfareRequestError('request_unavailable');
  try {
    return (data ?? []).map(decodeAirfareRequest);
  } catch {
    throw new AirfareRequestError('malformed_request');
  }
}

export async function fetchAirfareRequest(requestId: string): Promise<AirfareRequest | null> {
  const { data, error } = await supabase
    .from('collector_requests')
    .select(requestColumns)
    .eq('request_id', requestId)
    .eq('operation', OPERATION)
    .maybeSingle();
  if (error) throw new AirfareRequestError('request_unavailable');
  return data ? decodeAirfareRequest(data) : null;
}

export function subscribeAirfareRequests(onRequest: (request: AirfareRequest) => void): () => void {
  let disposed = false;
  const channel = supabase
    .channel('airfare-route-requests')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'collector_requests',
        filter: `operation=eq.${OPERATION}`,
      },
      (event) => {
        if (disposed) return;
        try {
          onRequest(decodeAirfareRequest(event.new));
        } catch {
          // Ignore malformed or delete events; polling remains the reconciliation path.
        }
      },
    )
    .subscribe();
  return () => {
    if (disposed) return;
    disposed = true;
    void supabase.removeChannel(channel);
  };
}

export function decodeAirfareRequest(raw: unknown): AirfareRequest {
  const row = record(raw);
  if (!row || row.operation !== OPERATION) malformed();
  const payload = decodePayload(row.payload);
  const progress = decodeProgress(row.progress);
  const status = enumValue(row.status, REQUEST_STATUSES);
  const result = row.result === null ? null : decodeResult(row.result);
  const requestId = text(row.request_id);
  const createdAt = timestamp(row.created_at);
  const expiresAt = timestamp(row.expires_at);
  const updatedAt = timestamp(row.updated_at);
  if (!status || !requestId || !createdAt || !expiresAt || !updatedAt) malformed();
  const errorCode = row.error_code === null ? null : safeErrorCode(row.error_code);
  return {
    requestId,
    payload,
    progress,
    status,
    result,
    errorCode,
    createdAt,
    expiresAt,
    updatedAt,
  };
}

const requestColumns =
  'request_id, operation, payload, progress, status, result, error_code, created_at, expires_at, updated_at';

function decodePayload(raw: unknown): AirfareRequestInput {
  const value = exactRecord(raw, ['origin', 'destination', 'month', 'currency']);
  if (
    !value ||
    !iata(value.origin) ||
    !iata(value.destination) ||
    !month(value.month) ||
    !currency(value.currency)
  )
    malformed();
  return {
    origin: value.origin,
    destination: value.destination,
    month: value.month,
    currency: value.currency,
  };
}

function decodeProgress(raw: unknown): AirfareRequestProgress {
  const value = exactRecord(raw, ['stage', 'completed', 'total']);
  const stage = value && enumValue(value.stage, PROGRESS_STAGES);
  if (
    !value ||
    !stage ||
    !count(value.completed) ||
    !(value.total === null || count(value.total)) ||
    (typeof value.total === 'number' && value.completed > value.total)
  )
    malformed();
  return { stage, completed: value.completed, total: value.total };
}

function decodeResult(raw: unknown): AirfareRequestResult {
  const value = exactRecord(raw, [
    'origin',
    'destination',
    'month',
    'lookedAt',
    'changed',
    'failed',
    'skipped',
    'synced',
  ]);
  if (
    !value ||
    !iata(value.origin) ||
    !iata(value.destination) ||
    !month(value.month) ||
    !count(value.lookedAt) ||
    !count(value.changed) ||
    !count(value.failed) ||
    !count(value.skipped) ||
    value.synced !== true
  )
    malformed();
  return {
    origin: value.origin,
    destination: value.destination,
    month: value.month,
    lookedAt: value.lookedAt,
    changed: value.changed,
    failed: value.failed,
    skipped: value.skipped,
    synced: true,
  };
}

function malformed(): never {
  throw new AirfareRequestError('malformed_request');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  const item = record(value);
  return item && Object.keys(item).length === keys.length && keys.every((key) => key in item)
    ? item
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function iata(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function currency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function month(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}

function safeErrorCode(value: unknown): string {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : 'request_failed';
}
