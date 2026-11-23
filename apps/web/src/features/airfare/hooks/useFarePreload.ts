import { useContext, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { subscribeToAuth } from '@/shared/auth/supabaseAuth';
import { AuthenticatedOwnerContext } from '@/shared/auth/AuthenticatedOwnerContext';
import { createFarePreloader } from '../data/farePreloader';
import type { FareRoute } from '../data/fareRoutes';

/** Data preparation is independent of selection and chart visibility. */
export function useFarePreload(
  routes: readonly FareRoute[],
  today: string,
  selectedId: string | null,
): void {
  const client = useQueryClient();
  const renderedOwner = useContext(AuthenticatedOwnerContext);
  const inputs = useRef({ routes, today, selectedId });
  const active = useRef<{
    loader: ReturnType<typeof createFarePreloader>;
    authenticated: boolean;
  } | null>(null);

  useEffect(() => {
    inputs.current = { routes, today, selectedId };
    if (active.current?.authenticated) active.current.loader.update(routes, today, selectedId);
  }, [routes, today, selectedId]);

  useEffect(() => {
    if (!renderedOwner) return;
    const instance = { loader: createFarePreloader(client), authenticated: false };
    active.current = instance;
    let stopped = false;
    const stop = subscribeToAuth((_event, session) => {
      if (stopped) return;
      const nextOwner = session?.user.id;
      // Even the first callback may describe a newer session than the tree
      // whose watchlist we received. Never preload that old list for a new user.
      if (nextOwner !== renderedOwner) {
        stopped = true;
        instance.authenticated = false;
        instance.loader.dispose();
        return;
      }
      instance.authenticated = true;
      const current = inputs.current;
      instance.loader.update(current.routes, current.today, current.selectedId);
    });
    return () => {
      stopped = true;
      stop();
      instance.loader.dispose();
      active.current = null;
    };
  }, [client, renderedOwner]);
}
