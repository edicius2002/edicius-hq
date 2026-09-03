import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppBrowserRouter } from '@/app/router/createAppRouter';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { fetchSessionStatus } from '@/features/auth/ceremony';
import { PriceAlertsWatcher } from '@/features/investing/PriceAlertsWatcher';
import { readToken } from '@/shared/auth/session';
import { ToastHost } from '@/shared/ui/ToastHost';

const router = createAppBrowserRouter();

type SessionStatus = 'checking' | 'authenticated' | 'anonymous';

export function App() {
  /*
   * One gate, around the router rather than inside each route. A guard per
   * route is a guard somebody can forget to add to the next one, and the
   * question here is not "may you see this page" — there is one user and they
   * may see all of them — but "are you the owner at all".
   *
   * A token that exists is not a token that works, so a stored one is checked
   * before the app is drawn. Without that, a session that expired while the
   * tab was closed would render the whole shell and then fail every request in
   * it, which reads as a broken app rather than as a finished session.
   */
  const [status, setStatus] = useState<SessionStatus>(() =>
    readToken() ? 'checking' : 'anonymous',
  );

  useEffect(() => {
    if (status !== 'checking') return;

    const controller = new AbortController();
    fetchSessionStatus(controller.signal).then(
      () => setStatus('authenticated'),
      () => {
        /*
         * Any failure lands on the login screen, not only a 401. A token the
         * API will not confirm is a token this app cannot use, and the login
         * screen at least says what is wrong; the alternative is a shell whose
         * every panel reports its own error separately. `http.ts` has already
         * cleared the token if the answer was a 401 — and deliberately has not
         * if it was anything else, so a session survives the API being briefly
         * unreachable and works again on the next load.
         */
        if (!controller.signal.aborted) setStatus('anonymous');
      },
    );

    return () => controller.abort();
  }, [status]);

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
        {status === 'anonymous' ? (
          <LoginScreen onSignedIn={() => setStatus('authenticated')} />
        ) : null}
      </AppProviders>
    </AppErrorBoundary>
  );
}
