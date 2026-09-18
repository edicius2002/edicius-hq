import { vi } from 'vitest';

/** What `stubKvStore` hands back: the writes it saw, and whatever it is holding. */
export interface KvStoreStub<T> {
  /** Every value the hook has saved, deep-copied at the moment it arrived. */
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
  /** Hold each document write open this long, so a second write can arrive mid-flight. */
  writeDelayMs?: number;
  /** Fail the nth write — 1-based — with a 500, leaving the store as it was. */
  failPutAt?: number;
}

/**
 * The app-documents Supabase surface every storage-backed hook talks to, as a fetch stub.
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
  let revision = stored === null ? 0 : 1;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rpc/write_app_document')) {
        puts += 1;
        if (puts === failPutAt) {
          return Response.json({ detail: 'storage unavailable' }, { status: 500 });
        }
        const body = JSON.parse(String(init?.body)) as {
          p_payload: T;
          p_expected_revision: number;
        };
        if (writeDelayMs) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
        if (body.p_expected_revision !== revision) {
          return Response.json({ code: 'PT409' }, { status: 409 });
        }
        stored = body.p_payload;
        revision += 1;
        writes.push(structuredClone(body.p_payload));
        return Response.json({
          document_key: key,
          payload: body.p_payload,
          revision,
          updated_at: '2026-09-17T00:00:00.000Z',
        });
      }

      if (readFails) return Response.json({ detail: 'boom' }, { status: 500 });
      if (stored === null) return Response.json([]);
      return Response.json([
        { document_key: key, payload: stored, revision, updated_at: '2026-09-17T00:00:00.000Z' },
      ]);
    }),
  );

  return {
    writes,
    get stored() {
      return stored;
    },
  };
}
