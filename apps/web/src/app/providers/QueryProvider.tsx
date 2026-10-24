import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';

import { marketBarCache } from '@/features/investing/data/marketBarCache';
import { subscribeToAuth } from '@/shared/auth/supabaseAuth';

type QueryProviderProps = {
  children: ReactNode;
};

export function QueryProvider({ children }: QueryProviderProps) {
  const [client] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    });
    // Saved charts for other assets should survive ordinary navigation
    // within an Investing session, without retaining them indefinitely.
    client.setQueryDefaults(['market', 'bars'], { gcTime: 30 * 60_000 });
    return client;
  });

  useEffect(() => {
    let initialized = false;
    let ownerId: string | null = null;
    return subscribeToAuth((_event, session) => {
      const nextOwner = session?.user.id ?? null;
      if (initialized && nextOwner !== ownerId) {
        // All pages share this client; unscoped document keys must not survive
        // a change of authenticated owner. Removal also cancels active reads.
        client.removeQueries();
        void marketBarCache.clear();
      }
      ownerId = nextOwner;
      initialized = true;
    });
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
