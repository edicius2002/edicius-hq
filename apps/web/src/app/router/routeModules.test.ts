import { afterEach, expect, it, vi } from 'vitest';
import { preloadRoute, routeModules } from './routeModules';
vi.mock('@/features/seace/SeacePage', () => ({ SeacePage: () => null }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('shares the module promise between SEACE views and the route renderer', async () => {
  const first = routeModules.seace();
  expect(routeModules.seace()).toBe(first);
  await preloadRoute('/seace/recent');
  await preloadRoute('/seace/closed');
  expect(await first).toEqual({ default: expect.any(Function) });
});
it('does not load unknown routes or opportunistic chunks with data saving enabled', async () => {
  const load = vi.spyOn(routeModules, 'seace');
  await preloadRoute('/unknown');
  vi.stubGlobal('navigator', { connection: { saveData: true } });
  await preloadRoute('/seace/published');
  expect(load).not.toHaveBeenCalled();
});
it('absorbs a speculative error without preventing another attempt', async () => {
  const load = vi.spyOn(routeModules, 'seace').mockRejectedValueOnce(new Error('offline'));
  await expect(preloadRoute('/seace/recent')).resolves.toBeUndefined();
  await preloadRoute('/seace/recent');
  expect(load).toHaveBeenCalledTimes(2);
});
