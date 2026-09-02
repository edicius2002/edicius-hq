import { RouterProvider } from 'react-router-dom';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppBrowserRouter } from '@/app/router/createAppRouter';
import { PriceAlertsWatcher } from '@/features/investing/PriceAlertsWatcher';
import { ToastHost } from '@/shared/ui/ToastHost';

const router = createAppBrowserRouter();

export function App() {
  return (
    <AppErrorBoundary>
      <AppProviders>
        {/* Above the router, not inside a route: a price alert must keep
            watching and a toast must still be able to show up while the
            user is on Finance or Airfare, not only while Investing is
            mounted. */}
        <PriceAlertsWatcher />
        <ToastHost />
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  );
}
