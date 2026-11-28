import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/shared/backend', () => ({ isNeonBackend: true }));
vi.mock('@/shared/supabase/client', () => ({ supabase: {} }));
import { openQuoteStream } from './quoteStream';

class ProbeSource extends EventTarget {
  static opened: ProbeSource[] = [];
  onerror?: () => void;
  close = vi.fn();
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    ProbeSource.opened.push(this);
  }
}

afterEach(() => {
  ProbeSource.opened = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('waits for the Pi, decodes quotes, and releases the stream when the tab goes away', () => {
  vi.stubEnv('VITE_MARKET_LIVE_ENABLED', 'true');
  vi.stubGlobal('EventSource', ProbeSource);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const onOpen = vi.fn();
  const onError = vi.fn();
  const onTicks = vi.fn();
  const close = openQuoteStream(['BTCUSDT'], {
    focus: { symbol: 'BTCUSDT', timeframe: '1m' },
    onOpen,
    onError,
    onTicks,
  });
  const [source] = ProbeSource.opened;
  expect(source.url).toBe('/api/market/live?symbols=BTCUSDT&symbol=BTCUSDT&frame=1m');
  source.dispatchEvent(new Event('open'));
  expect(onOpen).not.toHaveBeenCalled();
  source.dispatchEvent(new Event('ready'));
  expect(onOpen).toHaveBeenCalledTimes(1);
  source.dispatchEvent(new MessageEvent('ticks', { data: 'invalid json' }));
  expect(onTicks).not.toHaveBeenCalled();
  const tick = {
    symbol: 'BTCUSDT',
    price: 42,
    time: 120,
    extended: false,
    marketState: 'REGULAR',
    changePercent: null,
  };
  source.dispatchEvent(new MessageEvent('ticks', { data: JSON.stringify([tick]) }));
  expect(onTicks).toHaveBeenCalledWith([tick]);
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(onError).toHaveBeenCalled();
  expect(source.close).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(ProbeSource.opened).toHaveLength(2);
  close();
  expect(ProbeSource.opened[1].close).toHaveBeenCalledTimes(1);
});

it('stops retrying after unmount during reconnect backoff', () => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_MARKET_LIVE_ENABLED', 'true');
  vi.stubGlobal('EventSource', ProbeSource);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const stop = openQuoteStream(['AAPL'], { onTicks: vi.fn() });
  ProbeSource.opened[0].onerror?.();
  vi.advanceTimersByTime(1000);
  expect(ProbeSource.opened).toHaveLength(2);
  ProbeSource.opened[1].onerror?.();
  stop();
  vi.advanceTimersByTime(60_000);
  expect(ProbeSource.opened).toHaveLength(2);
});
