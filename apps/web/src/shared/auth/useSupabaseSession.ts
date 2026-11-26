import { useEffect, useState } from 'react';

import { isNeonBackend } from '@/shared/backend';

import { getAccessToken, getOwnerId, subscribeToAuth } from '@/shared/auth/supabaseAuth';

export type SupabaseSessionStatus = 'checking' | 'authenticated' | 'anonymous' | 'error';

/** Keeps the application gate in step with the browser's Supabase session. */
export function useSupabaseSession(): {
  status: SupabaseSessionStatus;
  ownerId: string | null;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
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

    if (isNeonBackend) {
      void getOwnerId().then(
        (id) => {
          if (!mounted || receivedAuthEvent) return;
          setOwnerId(id);
          setStatus(id ? 'authenticated' : 'anonymous');
        },
        () => {
          if (mounted && !receivedAuthEvent) setStatus('error');
        },
      );
      return () => {
        mounted = false;
        unsubscribe();
      };
    }

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
  }, [attempt]);

  return {
    status,
    ownerId,
    retry: () => {
      setStatus('checking');
      setAttempt((value) => value + 1);
    },
  };
}
