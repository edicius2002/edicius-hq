import type { ComponentType } from 'react';

// Navigation and speculative loading use the same promise. Rejected attempts
// are evicted so a transient prefetch failure does not poison the route.
function moduleLoader(load: () => Promise<{ default: ComponentType }>) {
  let pending: Promise<{ default: ComponentType }> | undefined;
  return () => {
    if (!pending) {
      pending = load().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

export const routeModules = {
  dashboard: moduleLoader(() =>
    import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
  ),
  finance: moduleLoader(() =>
    import('@/features/finance/FinancePage').then((m) => ({ default: m.FinancePage })),
  ),
  greenlight: moduleLoader(() =>
    import('@/features/greenlight/GreenlightPage').then((m) => ({ default: m.GreenlightPage })),
  ),
  investing: moduleLoader(() =>
    import('@/features/investing/InvestingPage').then((m) => ({ default: m.InvestingPage })),
  ),
  airfare: moduleLoader(() =>
    import('@/features/airfare/AirfarePage').then((m) => ({ default: m.AirfarePage })),
  ),
  seace: moduleLoader(() =>
    import('@/features/seace/SeacePage').then((m) => ({ default: m.SeacePage })),
  ),
  sentiment: moduleLoader(() =>
    import('@/features/sentiment/SentimentPage').then((m) => ({ default: m.SentimentPage })),
  ),
};

export async function preloadRoute(pathname: string): Promise<void> {
  const connection =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (
    connection?.saveData ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  )
    return;
  const route = pathname.split('/')[1];
  if (!Object.hasOwn(routeModules, route)) return;
  try {
    await routeModules[route as keyof typeof routeModules]();
  } catch {
    /* Navigation owns errors. */
  }
}
