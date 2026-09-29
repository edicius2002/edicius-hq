import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: mock.rpc } }));
import { fetchLatest, fetchHistory } from './data';
beforeEach(() => {
  vi.resetAllMocks();
  mock.rpc.mockReturnValue({ abortSignal: mock.abortSignal });
});
it('reads latest through the authenticated RPC and rejects null responses', async () => {
  const signal = new AbortController().signal;
  mock.abortSignal.mockResolvedValue({ data: [], error: null });
  await expect(fetchLatest(signal)).resolves.toEqual([]);
  expect(mock.rpc).toHaveBeenCalledWith('read_fx_latest');
  expect(mock.abortSignal).toHaveBeenCalledWith(signal);
  mock.abortSignal.mockResolvedValue({ data: null, error: null });
  await expect(fetchLatest(signal)).rejects.toThrow();
});
it('passes exact selected source/range arguments and surfaces server failure', async () => {
  const signal = new AbortController().signal;
  mock.abortSignal.mockResolvedValue({ data: { points: [], aggregation: 'daily' }, error: null });
  await expect(fetchHistory('sbs', 'ALL', signal)).resolves.toEqual({
    points: [],
    aggregation: 'daily',
  });
  expect(mock.rpc).toHaveBeenCalledWith('read_fx_history', { p_source: 'sbs', p_range: 'ALL' });
  expect(mock.abortSignal).toHaveBeenCalledWith(signal);
  mock.abortSignal.mockResolvedValue({ data: null, error: new Error('owner access required') });
  await expect(fetchHistory('sbs', 'ALL', signal)).rejects.toThrow('owner access required');
});
