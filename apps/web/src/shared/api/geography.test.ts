import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSubdivisionCatalogue, fetchSubdivisions } from '@/shared/api/geography';

/**
 * Which absences are answers and which are failures.
 *
 * The map is decoration over data, so it swallows a great deal — but not
 * everything, and where the line falls is the whole content of this module.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function answering(response: Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(response);
    }),
  );
  return calls;
}

describe('fetchSubdivisions', () => {
  it('reads a country with nothing to divide as an answer rather than a failure', async () => {
    // Natural Earth divides 167 of the 177 countries the map draws. For the
    // other ten there is nothing to draw, and that is not an error.
    answering(new Response('null', { status: 404 }));
    await expect(fetchSubdivisions('732')).resolves.toBeNull();
  });

  it('reports a real failure rather than swallowing it as an empty country', async () => {
    /*
     * The 404 is swallowed because it is an answer. A 500 from our own API is
     * a bug, and drawing nothing would be the map hiding it — the caller is
     * still free to keep quiet about it, but it has to be told.
     */
    answering(new Response('{"detail":"boom"}', { status: 500 }));
    await expect(fetchSubdivisions('604')).rejects.toThrow();
  });
});

describe('fetchSubdivisionCatalogue', () => {
  it('asks the collection rather than a member of it', async () => {
    const calls = answering(Response.json({ countries: { '604': 43085 } }));
    await expect(fetchSubdivisionCatalogue()).resolves.toEqual({ countries: { '604': 43085 } });
    expect(calls[0]).toMatch(/\/api\/geography\/subdivisions$/);
  });

  it('throws where the geometry would have kept quiet', async () => {
    /*
     * The asymmetry is deliberate. A country with no file is an answer; an
     * index that will not load is our own API failing, and the map's fallback
     * — detail the one country under the middle of the frame, as it did before
     * there was an index — is a decision for the caller to take knowingly
     * rather than one hidden in a `null`.
     */
    answering(new Response('null', { status: 404 }));
    await expect(fetchSubdivisionCatalogue()).rejects.toThrow();
  });
});
