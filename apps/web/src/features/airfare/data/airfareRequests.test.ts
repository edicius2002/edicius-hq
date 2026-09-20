import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const rpc = vi.fn();
  const maybeSingle = vi.fn();
  const requestEq = vi.fn(() => ({ maybeSingle }));
  const activeOrder = vi.fn();
  const activeGt = vi.fn(() => ({ order: activeOrder }));
  const activeIn = vi.fn(() => ({ gt: activeGt }));
  const operationEq = vi.fn(() => ({ in: activeIn, eq: requestEq }));
  const select = vi.fn(() => ({ eq: operationEq }));
  const from = vi.fn(() => ({ select }));
  const subscribe = vi.fn(() => ({ id: 'airfare-requests' }));
  let handler: ((event: { new: unknown }) => void) | undefined;
  const on = vi.fn((_event, _filter, callback) => {
    handler = callback;
    return { subscribe };
  });
  const channel = vi.fn(() => ({ on }));
  const removeChannel = vi.fn();
  return {
    rpc,
    from,
    select,
    operationEq,
    activeIn,
    activeGt,
    activeOrder,
    requestEq,
    maybeSingle,
    channel,
    on,
    subscribe,
    removeChannel,
    emit: (row: unknown) => handler?.({ new: row }),
  };
});

vi.mock('@/shared/supabase/client', () => ({ supabase: state }));

import {
  AirfareRequestError,
  decodeAirfareRequest,
  enqueueAirfareRequest,
  fetchActiveAirfareRequests,
  fetchAirfareRequest,
  subscribeAirfareRequests,
} from './airfareRequests';

const ROW = {
  request_id: '11111111-1111-4111-8111-111111111111',
  operation: 'airfare-route',
  payload: { origin: 'LIM', destination: 'CUZ', month: '2026-11', currency: 'USD' },
  progress: { stage: 'collecting', completed: 1, total: 3 },
  status: 'running',
  result: null,
  error_code: null,
  created_at: '2026-09-19T12:00:00.000Z',
  expires_at: '2026-09-19T12:10:00.000Z',
  updated_at: '2026-09-19T12:01:00.000Z',
};

afterEach(() => vi.clearAllMocks());

describe('Airfare request boundary', () => {
  it('normalizes the route and invokes the owner-safe enqueue RPC', async () => {
    state.rpc.mockResolvedValue({ data: ROW, error: null });

    await expect(
      enqueueAirfareRequest({
        origin: 'lim',
        destination: 'cuz',
        month: '2026-11',
        currency: 'usd',
      }),
    ).resolves.toMatchObject({ requestId: ROW.request_id, status: 'running' });
    expect(state.rpc).toHaveBeenCalledWith('enqueue_airfare_route_request', {
      p_origin: 'LIM',
      p_destination: 'CUZ',
      p_month: '2026-11',
      p_currency: 'USD',
    });
  });

  it('strictly decodes progress and completed results', () => {
    expect(
      decodeAirfareRequest({
        ...ROW,
        status: 'complete',
        progress: { stage: 'syncing', completed: 3, total: 3 },
        result: {
          origin: 'LIM',
          destination: 'CUZ',
          month: '2026-11',
          lookedAt: 3,
          changed: 2,
          failed: 0,
          skipped: 1,
          synced: true,
        },
      }),
    ).toMatchObject({
      progress: { stage: 'syncing', completed: 3, total: 3 },
      result: { changed: 2, synced: true },
    });
    expect(() => decodeAirfareRequest({ ...ROW, progress: { completed: 1, total: 3 } })).toThrow(
      AirfareRequestError,
    );
    expect(() =>
      decodeAirfareRequest({ ...ROW, payload: { ...ROW.payload, extra: 'leak' } }),
    ).toThrow('malformed_request');
  });

  it('reads only live active Airfare route requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
    state.activeOrder.mockResolvedValue({ data: [ROW], error: null });

    await expect(fetchActiveAirfareRequests()).resolves.toHaveLength(1);
    expect(state.operationEq).toHaveBeenCalledWith('operation', 'airfare-route');
    expect(state.activeIn).toHaveBeenCalledWith('status', ['queued', 'running']);
    expect(state.activeGt).toHaveBeenCalledWith('expires_at', '2026-09-19T12:00:00.000Z');
    expect(state.activeOrder).toHaveBeenCalledWith('created_at', { ascending: true });
    vi.useRealTimers();
  });

  it('polls a request by id and operation and maps database errors to a fixed code', async () => {
    state.maybeSingle.mockResolvedValueOnce({ data: ROW, error: null });
    await expect(fetchAirfareRequest(ROW.request_id)).resolves.toMatchObject({
      requestId: ROW.request_id,
    });
    expect(state.operationEq).toHaveBeenCalledWith('request_id', ROW.request_id);
    expect(state.requestEq).toHaveBeenCalledWith('operation', 'airfare-route');

    state.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'owner secret' } });
    await expect(fetchAirfareRequest(ROW.request_id)).rejects.toMatchObject({
      code: 'request_unavailable',
    });
  });

  it('subscribes to owner-visible Airfare rows, ignores malformed events, and disposes once', () => {
    const receive = vi.fn();
    const dispose = subscribeAirfareRequests(receive);
    state.emit(ROW);
    state.emit({ ...ROW, payload: { bad: true } });
    dispose();
    dispose();

    expect(state.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: '*',
        schema: 'public',
        table: 'collector_requests',
        filter: 'operation=eq.airfare-route',
      }),
      expect.any(Function),
    );
    expect(receive).toHaveBeenCalledOnce();
    expect(state.removeChannel).toHaveBeenCalledOnce();
  });
});
