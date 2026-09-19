/** Internal, atomic history assembly. No page escapes into the query cache. */
import type { FareHistoryResponse } from '@/shared/api/fares';
import type { Database } from '@/shared/supabase/database.types';

type HistoryFilters = Database['public']['Functions']['read_owner_airfare_history']['Args'];
type HistoryArguments =
  | Database['public']['Functions']['read_owner_airfare_history_meta']['Args']
  | Database['public']['Functions']['read_owner_airfare_history_page']['Args'];

type Dataset = 'snapshots' | 'baseline';
type Position = [string, string, string];
type HistoryCursor = {
  protocolVersion: 1;
  queryKey: string;
  revision: string;
  dataset: Dataset;
  after: Position;
};
type HistoryItem = { recordId: string; order: Position; payload: Record<string, unknown> };
type HistoryMeta = Omit<FareHistoryResponse, 'snapshots' | 'baseline'> & {
  protocolVersion: 1;
  queryKey: string;
  revision: string;
  counts: { snapshots: string; baseline: string };
};
type HistoryPage = {
  protocolVersion: 1;
  queryKey: string;
  revision: string;
  dataset: Dataset;
  items: HistoryItem[];
  nextCursor: HistoryCursor | null;
};
type HistoryRpc = (
  name: 'read_owner_airfare_history_meta' | 'read_owner_airfare_history_page',
  params: HistoryArguments,
  signal: AbortSignal,
) => Promise<unknown>;

export class HistoryRevisionChanged extends Error {
  constructor() {
    super('Airfare history revision changed.');
    this.name = 'HistoryRevisionChanged';
  }
}

function reject(): never {
  throw new Error('Invalid Airfare history protocol response.');
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}

function decimal(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) reject();
  const result = BigInt(value);
  if (result.toString() !== value || result > 9223372036854775807n || (positive && result === 0n))
    reject();
  return result;
}

function number(value: unknown, integral = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) reject();
  if (integral && (!Number.isInteger(value) || value < 0)) reject();
  return value;
}

function header(value: unknown): Record<string, unknown> {
  const body = object(value);
  if (body.protocolVersion !== 1) reject();
  decimal(body.revision, true);
  if (
    typeof body.queryKey !== 'string' ||
    body.queryKey.length !== 32 ||
    !/^[0-9a-f]+$/.test(body.queryKey)
  )
    reject();
  return body;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) ||
    Array.isArray(b)
  )
    return false;
  const left = object(a);
  const right = object(b);
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
  );
}

function parseMeta(value: unknown, params: Record<string, unknown>): HistoryMeta {
  const meta = header(value);
  if (meta.origin !== params.p_origin || meta.destination !== params.p_destination) reject();
  const counts = object(meta.counts);
  if (Object.keys(counts).length !== 2) reject();
  decimal(counts.snapshots);
  decimal(counts.baseline);
  const health = object(meta.health);
  if (health.lastCheckedAt !== null && typeof health.lastCheckedAt !== 'string') reject();
  for (const key of ['checks', 'changes', 'errors']) number(health[key], true);
  if (!Array.isArray(meta.airports)) reject();
  const codes: unknown[] = [];
  for (const value of meta.airports) {
    const airport = object(value);
    if (airport.code !== params.p_origin && airport.code !== params.p_destination) reject();
    codes.push(airport.code);
    for (const key of ['name', 'city', 'country']) {
      if (airport[key] !== undefined && airport[key] !== null && typeof airport[key] !== 'string')
        reject();
    }
    number(airport.latitude);
    number(airport.longitude);
  }
  const expectedCodes = [
    ...new Set([params.p_origin, params.p_destination].filter((code) => codes.includes(code))),
  ];
  if (!same(codes, expectedCodes)) reject();
  if (meta.pairReference !== null) {
    const reference = object(meta.pairReference);
    number(reference.value);
    if (number(reference.dates, true) === 0) reject();
  }
  // Fields above are narrowed at the wire boundary; preserve original objects,
  // including optional fields omitted by historical airport records.
  return meta as HistoryMeta;
}

function position(value: unknown, dataset: Dataset): Position {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'string'))
    reject();
  const parts = value as Position;
  if (parts[2].length !== 64 || !/^[0-9a-f]+$/.test(parts[2])) reject();
  if (dataset === 'snapshots') decimal(parts[1], true);
  else {
    for (const day of parts.slice(0, 2)) {
      if (day.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day) || day.startsWith('0000'))
        reject();
      const parsed = new Date(`${day}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) reject();
    }
  }
  return parts;
}

function compare(a: Position, b: Position, dataset: Dataset): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  const secondA = dataset === 'snapshots' ? BigInt(a[1]) : a[1];
  const secondB = dataset === 'snapshots' ? BigInt(b[1]) : b[1];
  if (secondA !== secondB) return secondA < secondB ? -1 : 1;
  return a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1;
}

function parsePage(
  value: unknown,
  meta: HistoryMeta,
  dataset: Dataset,
  previous: HistoryCursor | null,
): HistoryPage {
  const page = header(value);
  if (
    page.queryKey !== meta.queryKey ||
    page.revision !== meta.revision ||
    page.dataset !== dataset
  )
    reject();
  if (!Array.isArray(page.items) || page.items.length > 250 || !Object.hasOwn(page, 'nextCursor'))
    reject();
  let last = previous ? position(previous.after, dataset) : null;
  for (const value of page.items) {
    const item = object(value);
    const order = position(item.order, dataset);
    if (item.recordId !== order[2] || (last && compare(order, last, dataset) <= 0)) reject();
    object(item.payload);
    last = order;
  }
  if (page.nextCursor !== null) {
    header(page.nextCursor);
    if (
      !last ||
      !same(page.nextCursor, {
        protocolVersion: 1,
        queryKey: meta.queryKey,
        revision: meta.revision,
        dataset,
        after: last,
      })
    )
      reject();
    if (page.items.length === 0) reject();
  }
  return page as HistoryPage;
}

/** The transport receives the signal; this race also prevents late publication. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, rejectPromise) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      // AbortSignal reasons are deliberately preserved, including non-Errors.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      rejectPromise(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        // Preserve the caller's cancellation reason or transport rejection.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        rejectPromise(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) abort();
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, rejectPromise) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      // Preserve AbortSignal cancellation semantics.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      rejectPromise(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readAttempt(
  rpc: HistoryRpc,
  params: HistoryFilters,
  signal: AbortSignal,
): Promise<FareHistoryResponse> {
  const request = async (name: Parameters<HistoryRpc>[0], values: HistoryArguments) => {
    signal.throwIfAborted();
    const result = await abortable(rpc(name, values, signal), signal);
    signal.throwIfAborted();
    return result;
  };
  const meta = parseMeta(await request('read_owner_airfare_history_meta', params), params);
  const datasetController = new AbortController();
  const abortDatasets = () => datasetController.abort(signal.reason);
  signal.addEventListener('abort', abortDatasets, { once: true });
  if (signal.aborted) abortDatasets();
  const datasetSignal = datasetController.signal;
  const datasetRequest = async (name: Parameters<HistoryRpc>[0], values: HistoryArguments) => {
    datasetSignal.throwIfAborted();
    const result = await abortable(rpc(name, values, datasetSignal), datasetSignal);
    datasetSignal.throwIfAborted();
    return result;
  };
  const readDataset = async (dataset: Dataset): Promise<Record<string, unknown>[]> => {
    const assembled: Record<string, unknown>[] = [];
    const expected = decimal(meta.counts[dataset]);
    const identities = new Set<string>();
    let cursor: HistoryCursor | null = null;
    let received = 0n;
    while (expected > 0n) {
      const page = parsePage(
        await datasetRequest('read_owner_airfare_history_page', {
          ...params,
          p_revision: meta.revision,
          p_dataset: dataset,
          p_cursor: cursor,
          p_page_size: 250,
        }),
        meta,
        dataset,
        cursor,
      );
      for (const item of page.items) {
        if (identities.has(item.recordId)) reject();
        identities.add(item.recordId);
        assembled.push(item.payload);
        received += 1n;
      }
      cursor = page.nextCursor;
      if (received > expected || (cursor !== null && received >= expected)) reject();
      if (cursor === null) break;
    }
    if (received !== expected) reject();
    return assembled;
  };
  const guardedRead = async (dataset: Dataset) => {
    try {
      return await readDataset(dataset);
    } catch (error) {
      if (!datasetSignal.aborted) datasetController.abort(error);
      throw error;
    }
  };
  const reads = [guardedRead('snapshots'), guardedRead('baseline')] as const;
  const settled = await Promise.allSettled(reads);
  signal.removeEventListener('abort', abortDatasets);
  signal.throwIfAborted();
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
  const snapshots = (settled[0] as PromiseFulfilledResult<Record<string, unknown>[]>).value;
  const baseline = (settled[1] as PromiseFulfilledResult<Record<string, unknown>[]>).value;
  const final = parseMeta(
    await request('read_owner_airfare_history_meta', {
      ...params,
      p_expected_revision: meta.revision,
    }),
    params,
  );
  if (!same(meta, final)) reject();
  signal.throwIfAborted();
  return {
    origin: meta.origin,
    destination: meta.destination,
    health: meta.health,
    airports: meta.airports,
    pairReference: meta.pairReference,
    snapshots: snapshots as FareHistoryResponse['snapshots'],
    baseline: baseline as FareHistoryResponse['baseline'],
  };
}

export async function assembleHistory(
  rpc: HistoryRpc,
  params: HistoryFilters,
  callerSignal?: AbortSignal,
): Promise<FareHistoryResponse> {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abort, { once: true });
  if (callerSignal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('Airfare history deadline exceeded.')),
    60_000,
  );
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await readAttempt(rpc, params, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof HistoryRevisionChanged)) throw error;
        if (attempt === 2) throw new Error('Airfare history changed repeatedly.', { cause: error });
        await abortableDelay([100, 250][attempt], signal);
      }
    }
    throw new Error('Airfare history is unavailable.');
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}
