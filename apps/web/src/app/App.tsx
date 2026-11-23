import { RouterProvider } from 'react-router-dom';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppBrowserRouter } from '@/app/router/createAppRouter';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { NeonPasskeyTrial } from '@/features/auth/NeonPasskeyTrial';
import { PriceAlertsWatcher } from '@/features/investing/PriceAlertsWatcher';
import { useSupabaseSession } from '@/shared/auth/useSupabaseSession';
import { AuthenticatedOwnerContext } from '@/shared/auth/AuthenticatedOwnerContext';
import { ToastHost } from '@/shared/ui/ToastHost';
import { PageSkeleton } from '@/shared/ui/PageSkeleton';

const router = createAppBrowserRouter();

export function App() {
  if (window.location.pathname === '/__neon-passkey-trial') {
    return <NeonPasskeyTrial />;
  }
  return <MainApp />;
}

function MainApp() {
  const { status, ownerId, retry } = useSupabaseSession();

  return (
    <AppErrorBoundary>
      <AppProviders>
        {/* Above the router, and above the gate: a toast is how a failed sign-in
            reports itself, so it has to outlive the screen that raised it. */}
        <ToastHost />
        {status === 'authenticated' ? (
          <AuthenticatedOwnerContext.Provider key={ownerId} value={ownerId}>
            {/* Above the router, not inside a route: a price alert must keep
                watching while the user is on Finance or Airfare, not only
                while Investing is mounted. Inside the gate, though — there is
                nothing to watch, and no session to watch it with, until
                somebody has signed in. */}
            <PriceAlertsWatcher />
            <RouterProvider router={router} />
          </AuthenticatedOwnerContext.Provider>
        ) : null}
        {status === 'anonymous' ? <LoginScreen /> : null}
        {status === 'error' ? (
          <div role="alert">
            Could not check your session. <button onClick={retry}>Retry</button>
          </div>
        ) : null}
        {status === 'checking' ? <PageSkeleton page="login" /> : null}
      </AppProviders>
    </AppErrorBoundary>
  );
}
