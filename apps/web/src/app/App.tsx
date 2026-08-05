import { RouterProvider } from 'react-router-dom';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppBrowserRouter } from '@/app/router/createAppRouter';

const router = createAppBrowserRouter();

export function App() {
  return (
    <AppErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  );
}
