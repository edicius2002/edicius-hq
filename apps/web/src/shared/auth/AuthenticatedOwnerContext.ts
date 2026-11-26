import { createContext } from 'react';

/** Identity that owns the currently rendered authenticated tree and its inputs. */
export const AuthenticatedOwnerContext = createContext<string | null>(null);
