import { Navigate, type RouteObject } from 'react-router-dom';

import { AppShell } from '@/app/layout/AppShell';
import { NotFoundPage } from '@/app/router/NotFoundPage';
import { RouteErrorPage } from '@/app/router/RouteErrorPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { FinancePage } from '@/features/finance/FinancePage';
import { GreenlightPage } from '@/features/greenlight/GreenlightPage';
import { InvestingPage } from '@/features/investing/InvestingPage';

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
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
