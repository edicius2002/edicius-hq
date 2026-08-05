import { RouterProvider } from 'react-router-dom';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { createAppBrowserRouter } from '@/app/router/createAppRouter';

const router = createAppBrowserRouter();

export function App() {
  return (
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  );
}
