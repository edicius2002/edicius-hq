import { vi } from 'vitest';

/** What `stubKvStore` hands back: the writes it saw, and whatever it is holding. */
export interface KvStoreStub<T> {
  /** Every value the hook has PUT, deep-copied at the moment it arrived. */
  readonly writes: T[];
  /** The document as the store holds it now — the same object, so tests may edit it in place. */
  readonly stored: T;
}

export interface KvStoreOptions<T> {
  /** The KV key the endpoint answers under; it comes back in every response. */
  key: string;
  /**
   * What a GET finds before anything has been written. Left out, the store is
   * empty and answers 404 until the first PUT, which is what a page opened for
   * the first time sees. `stored` is typed `T` for the callers that seed one —
   * an unseeded store has nothing there to read, and none of them read it.
   */
  initial?: T | null;
  /** Break the initial GET with a 500, without breaking writes. */
  readFails?: boolean;
  /** Hold each PUT open this long, so a second write can arrive mid-flight. */
  writeDelayMs?: number;
  /** Fail the nth PUT — 1-based — with a 500, leaving the store as it was. */
  failPutAt?: number;
}

/**
 * The KV endpoint every storage-backed hook talks to, as a `fetch` stub.
 *
 * Five test files had grown their own copy of this — `stubApi`, `stubRoutes`,
 * `stubPortfolio`, `stubAlertRules` — differing in the key, the document type
 * and which two of the options they happened to need. They were the same body
 * otherwise, down to the `structuredClone` on the way into `writes` and the
 * `{ detail: 'boom' }` a failed read answers with, so a change to the KV
 * contract meant finding all five. This is the one place to change now.
 *
 * `writes` is cloned rather than aliased because the hooks mutate the document
 * they hold: without the copy every entry in the array would end up being the
 * same final object, and `writes[0]` could never disagree with `writes.at(-1)`.
 * `stored` is *not* cloned on the way out — Greenlight's tests reach in and
 * edit it to set up a second read.
 */
export function stubKvStore<T>(options: KvStoreOptions<T>): KvStoreStub<T> {
  const { key, readFails, writeDelayMs, failPutAt } = options;
  let stored = structuredClone(options.initial ?? null) as T;
  const writes: T[] = [];
  let puts = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        puts += 1;
        if (puts === failPutAt) {
          return Response.json({ detail: 'storage unavailable' }, { status: 500 });
        }
        const body = JSON.parse(String(init?.body)) as { value: T };
        if (writeDelayMs) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
        stored = body.value;
        writes.push(structuredClone(body.value));
        return Response.json({ key, value: body.value });
      }

      if (readFails) return Response.json({ detail: 'boom' }, { status: 500 });
      if (stored === null) return Response.json({ detail: 'Key not found' }, { status: 404 });
      return Response.json({ key, value: stored });
    }),
  );

  return {
    writes,
    get stored() {
      return stored;
    },
  };
}
