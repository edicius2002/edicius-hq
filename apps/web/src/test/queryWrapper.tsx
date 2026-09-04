import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

/**
 * Retries off, which is the only thing every one of these wrappers ever wanted.
 *
 * A query retries three times by default, so one stubbed 500 becomes four
 * requests and a test that asserts on a failure waits out two backoffs before
 * it sees one. Mutations already default to no retry, so the
 * `mutations: { retry: false }` that eight of these wrappers also carried was
 * the default written out — which is why the two spellings that existed here
 * were the same wrapper, and are now one function.
 */
const NO_RETRIES = { queries: { retry: false }, mutations: { retry: false } };

/**
 * A provider that builds a new `QueryClient` on every render.
 *
 * The usual one. Nothing is carried from one render to the next, let alone from
 * one `renderHook` to the next, so a cache assertion made through this wrapper
 * would pass for the wrong reason: there is never anything in there to hit.
 * That is exactly what most of these tests want — they are about what a hook
 * asks for and what it does with the answer, and a cache would only let an
 * earlier test's fetch show up in a later one.
 *
 * Use `sharedQueryWrapper` when the cache is the thing under test. The
 * difference between the two used to be invisible — a `new QueryClient()` in a
 * component body against one in a `useState` initialiser, three lines apart in
 * files that never said which they meant — and in several of them it read as an
 * accident rather than a decision. Naming the two forms is the point.
 */
export function queryWrapper() {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    const client = new QueryClient({ defaultOptions: NO_RETRIES });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** A `sharedQueryWrapper`, with the client it holds reachable for assertions. */
export interface SharedQueryWrapper {
  ({ children }: { children: ReactNode }): ReactElement;
  readonly client: QueryClient;
}

/**
 * A provider over one `QueryClient`, held for as long as the wrapper is.
 *
 * For the tests where the cache *is* the subject: that a second watch on the
 * same city pair reads the row the first one fetched, that a country already
 * loaded is not asked for twice. Those need the two renders to meet somewhere,
 * and with a fresh client each time they never would.
 *
 * The client hangs off the returned component so a test can look inside it —
 * `wrapper.client.getQueryCache().findAll(...)` — without the caller having to
 * build the client itself just to keep a reference to it.
 *
 * One per test rather than one per file: a client shared across tests would let
 * a country fetched by an earlier one appear in a later one, which is the fault
 * `queryWrapper` exists to avoid.
 */
export function sharedQueryWrapper(): SharedQueryWrapper {
  const client = new QueryClient({ defaultOptions: NO_RETRIES });
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Object.assign(Wrapper, { client });
}
