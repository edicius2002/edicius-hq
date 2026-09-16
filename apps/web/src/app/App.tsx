import { RouterProvider } from 'react-router-dom';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppBrowserRouter } from '@/app/router/createAppRouter';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { PriceAlertsWatcher } from '@/features/investing/PriceAlertsWatcher';
import { useSupabaseSession } from '@/shared/auth/useSupabaseSession';
import { ToastHost } from '@/shared/ui/ToastHost';

const router = createAppBrowserRouter();

export function App() {
  const { status } = useSupabaseSession();

  return (
    <AppErrorBoundary>
      <AppProviders>
        {/* Above the router, and above the gate: a toast is how a failed sign-in
            reports itself, so it has to outlive the screen that raised it. */}
        <ToastHost />
        {status === 'authenticated' ? (
          <>
            {/* Above the router, not inside a route: a price alert must keep
                watching while the user is on Finance or Airfare, not only
                while Investing is mounted. Inside the gate, though — there is
                nothing to watch, and no session to watch it with, until
                somebody has signed in. */}
            <PriceAlertsWatcher />
            <RouterProvider router={router} />
          </>
        ) : null}
        {status === 'anonymous' ? <LoginScreen /> : null}
      </AppProviders>
    </AppErrorBoundary>
  );
}
