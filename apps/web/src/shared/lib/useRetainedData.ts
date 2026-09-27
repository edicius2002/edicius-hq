import { useState } from 'react';

/** Keep the last answer during a replacement read, never across resource identities. */
export function useRetainedData<T>(scope: string, data: T | undefined): T | undefined {
  const [held, setHeld] = useState({ scope, data });
  if (held.scope !== scope || (data !== undefined && data !== held.data)) {
    setHeld({ scope, data });
  }
  return data !== undefined ? data : held.scope === scope ? held.data : undefined;
}
