import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';

import { marketBarCache } from '@/features/investing/data/marketBarCache';
import { subscribeToAuth } from '@/shared/auth/supabaseAuth';

type QueryProviderProps = {
  children: ReactNode;
};

export function QueryProvider({ children }: QueryProviderProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    let initialized = false;
    let ownerId: string | null = null;
    return subscribeToAuth((_event, session) => {
      const nextOwner = session?.user.id ?? null;
      if (initialized && nextOwner !== ownerId) {
        client.removeQueries({ queryKey: ['market', 'bars'] });
        void marketBarCache.clear();
      }
      ownerId = nextOwner;
      initialized = true;
    });
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
