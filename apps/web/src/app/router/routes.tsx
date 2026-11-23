/* eslint-disable react-refresh/only-export-components -- Route-owned lazy components; this module exports the route table. */
import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

import { AppShell } from '@/app/layout/AppShell';
import { NotFoundPage } from '@/app/router/NotFoundPage';
import { RouteErrorPage } from '@/app/router/RouteErrorPage';

import { routeModules } from './routeModules';

const DashboardPage = lazy(routeModules.dashboard);
const FinancePage = lazy(routeModules.finance);
const GreenlightPage = lazy(routeModules.greenlight);
const InvestingPage = lazy(routeModules.investing);
const AirfarePage = lazy(routeModules.airfare);
const SeacePage = lazy(routeModules.seace);
const SentimentPage = lazy(routeModules.sentiment);

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
      { path: 'seace', element: <Navigate to="/seace/recent" replace /> },
      { path: 'seace/recent', element: <SeacePage /> },
      { path: 'seace/all-open', element: <SeacePage /> },
      { path: 'seace/closed', element: <SeacePage /> },
      { path: 'seace/published', element: <SeacePage /> },
      { path: 'sentiment', element: <SentimentPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
