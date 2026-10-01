import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  abortSignal: vi.fn(),
  channel: vi.fn(),
  on: vi.fn(),
  subscribe: vi.fn(),
  removeChannel: vi.fn(),
}));
vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: mock.rpc,
    channel: mock.channel,
    removeChannel: mock.removeChannel,
  },
}));
import { fetchLatest, fetchHistory, subscribeFxObservations } from './data';
beforeEach(() => {
  vi.resetAllMocks();
  mock.rpc.mockReturnValue({ abortSignal: mock.abortSignal });
  mock.channel.mockReturnValue({ on: mock.on });
  mock.on.mockReturnValue({ on: mock.on, subscribe: mock.subscribe });
  mock.subscribe.mockReturnValue({ id: 'fx-channel' });
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
it('subscribes to owner inserts and updates and removes the channel', () => {
  const onChange = vi.fn();
  const close = subscribeFxObservations('owner-a', onChange);
  const filter = 'owner_id=eq.owner-a';
  expect(mock.channel).toHaveBeenCalledWith('fx-observations:owner-a');
  for (const event of ['INSERT', 'UPDATE']) {
    expect(mock.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event, schema: 'public', table: 'fx_observations', filter },
      onChange,
    );
  }
  expect(mock.subscribe).toHaveBeenCalledOnce();
  const subscriptions = mock.on.mock.calls as unknown as [string, object, () => void][];
  subscriptions[0][2]();
  subscriptions[1][2]();
  expect(onChange).toHaveBeenCalledTimes(2);
  close();
  expect(mock.removeChannel).toHaveBeenCalledWith({ id: 'fx-channel' });
});
