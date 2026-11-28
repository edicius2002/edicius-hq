import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvestingPage } from '@/features/investing/InvestingPage';

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <InvestingPage />
  </QueryClientProvider>,
);
