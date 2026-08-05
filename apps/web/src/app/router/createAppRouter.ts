import { createBrowserRouter, createMemoryRouter } from 'react-router-dom';

import { appRoutes } from '@/app/router/routes';

export function createAppBrowserRouter() {
  return createBrowserRouter(appRoutes);
}

export function createAppMemoryRouter(initialEntries: string[] = ['/']) {
  return createMemoryRouter(appRoutes, { initialEntries });
}
