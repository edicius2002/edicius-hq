import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

import { AppShell } from '@/app/layout/AppShell';
import { NotFoundPage } from '@/app/router/NotFoundPage';
import { RouteErrorPage } from '@/app/router/RouteErrorPage';

const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const FinancePage = lazy(() =>
  import('@/features/finance/FinancePage').then((m) => ({ default: m.FinancePage })),
);
const GreenlightPage = lazy(() =>
  import('@/features/greenlight/GreenlightPage').then((m) => ({ default: m.GreenlightPage })),
);
const InvestingPage = lazy(() =>
  import('@/features/investing/InvestingPage').then((m) => ({ default: m.InvestingPage })),
);
const AirfarePage = lazy(() =>
  import('@/features/airfare/AirfarePage').then((m) => ({ default: m.AirfarePage })),
);

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'finance', element: <FinancePage /> },
      { path: 'greenlight', element: <GreenlightPage /> },
      { path: 'investing', element: <InvestingPage /> },
      { path: 'airfare', element: <AirfarePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
