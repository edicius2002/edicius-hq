import { useEffect, useState } from 'react';

import { getAccessToken, subscribeToAuth } from '@/shared/auth/supabaseAuth';

export type SupabaseSessionStatus = 'checking' | 'authenticated' | 'anonymous';

/** Keeps the application gate in step with the browser's Supabase session. */
export function useSupabaseSession(): { status: SupabaseSessionStatus; ownerId: string | null } {
  const [status, setStatus] = useState<SupabaseSessionStatus>('checking');
  const [ownerId, setOwnerId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let receivedAuthEvent = false;
    const unsubscribe = subscribeToAuth((_event, session) => {
      receivedAuthEvent = true;
      if (mounted) {
        setOwnerId(session?.user?.id ?? null);
        setStatus(session ? 'authenticated' : 'anonymous');
      }
    });

    void getAccessToken().then(
      (token) => {
        if (mounted && !receivedAuthEvent) setStatus(token ? 'authenticated' : 'anonymous');
      },
      () => {
        if (mounted && !receivedAuthEvent) setStatus('anonymous');
      },
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { status, ownerId };
}
