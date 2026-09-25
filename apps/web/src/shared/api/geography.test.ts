import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSubdivisionCatalogue, fetchSubdivisions } from '@/shared/api/geography';

/**
 * Which absences are answers and which are failures.
 *
 * The map is decoration over data, so it swallows a great deal — but not
 * everything, and where the line falls is the whole content of this module.
 *
 * The files are static assets of the web app itself now, not a route on the
 * retired home API: production had no API behind `localhost:8000`, so the
 * globe asked for its subdivisions and never drew one.
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

/** What Vercel and Vite both answer for a static file that does not exist. */
const APP_SHELL = () =>
  new Response('<!doctype html><html></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

describe('fetchSubdivisions', () => {
  it('asks the web app for the country file, not the retired API', async () => {
    const calls = answering(Response.json({ type: 'Topology' }));
    await fetchSubdivisions('604');
    expect(calls[0]).toBe('/geography/subdivisions/604.json');
  });

  it('reads a country with nothing to divide as an answer rather than a failure', async () => {
    // Natural Earth divides 167 of the 177 countries the map draws. For the
    // other ten there is nothing to draw, and that is not an error.
    answering(new Response('null', { status: 404 }));
    await expect(fetchSubdivisions('732')).resolves.toBeNull();
  });

  it('reads the app shell a static host serves for a missing file as no country', async () => {
    // Vercel rewrites every unknown path to index.html, so a country without a
    // file arrives as a 200 page of HTML rather than a 404.
    answering(APP_SHELL());
    await expect(fetchSubdivisions('732')).resolves.toBeNull();
  });

  it('reports a real failure rather than swallowing it as an empty country', async () => {
    answering(new Response('boom', { status: 500 }));
    await expect(fetchSubdivisions('604')).rejects.toThrow();
  });
});

describe('fetchSubdivisionCatalogue', () => {
  it('asks the published index of the collection', async () => {
    const calls = answering(Response.json({ countries: { '604': 43085 } }));
    await expect(fetchSubdivisionCatalogue()).resolves.toEqual({ countries: { '604': 43085 } });
    expect(calls[0]).toBe('/geography/subdivisions/index.json');
  });

  it('throws where the geometry would have kept quiet', async () => {
    /*
     * The asymmetry is deliberate. A country with no file is an answer; an
     * index that will not load is our own deployment missing its data, and
     * the map's fallback is a decision for the caller to take knowingly.
     */
    answering(new Response('null', { status: 404 }));
    await expect(fetchSubdivisionCatalogue()).rejects.toThrow();
  });

  it('treats the app shell in place of the index as the failure it is', async () => {
    answering(APP_SHELL());
    await expect(fetchSubdivisionCatalogue()).rejects.toThrow();
  });
});
