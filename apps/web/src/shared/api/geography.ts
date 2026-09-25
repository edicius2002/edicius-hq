import { ApiError } from '@/shared/api/http';

/**
 * Map geography published as static files of the web app itself.
 *
 * Separate from `fares.ts` for the reason `routers/geography.py` gives on the
 * other side: an airport is on the archive's list because somebody watched a
 * route through it, and this is reference data that ships with the code and
 * that no collection creates.
 */

/** Where one subdivision's name goes, and how much ground it has. */
export type SubdivisionLabel = {
  name: string;
  /** Longitude and latitude of its largest piece. */
  at: [number, number];
  /** Solid angle in steradians — the half of the room test that never moves. */
  area: number;
};

export type SubdivisionsResponse = {
  /** ISO 3166-1 numeric, the id the bundled country outlines carry. */
  country: string;
  /**
   * A TopoJSON topology with two objects, sharing one set of arcs.
   *
   * `borders` is a `MultiLineString` of the boundaries *between* two
   * subdivisions. `land` is a `MultiPolygon` of the country itself, dissolved
   * out of the same units — which is why the two always meet: a 1:50m coast
   * under 1:10m provincial borders would leave every coastal province hanging
   * off the edge of its own country.
   */
  borders: unknown;
  labels: SubdivisionLabel[];
};

/** Every country that has subdivisions, and what each one costs to fetch. */
export type SubdivisionCatalogue = {
  /** ISO 3166-1 numeric to the byte length of that country's file. */
  countries: Record<string, number>;
};

/*
 * Where the files are. Static assets of this app, copied out of
 * `services/api/app/data/subdivisions` by `scripts/publish-geography.mjs`
 * before every build: they used to be a route on the home API, and production
 * has no API behind `localhost:8000`, so the globe asked and never drew one.
 */
const SUBDIVISIONS = `${import.meta.env.BASE_URL}geography/subdivisions`;

/**
 * The body of a published file, or `null` when there is no such file.
 *
 * A static host answers a missing file two ways: a 404, or — Vercel, and Vite's
 * dev server — the app's own `index.html` with a 200, because every unknown
 * path is rewritten to the single page. Both are "no file". Anything else that
 * is not a JSON body is a failure worth hearing about.
 */
async function publishedJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(path, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(`Could not load ${path}`, response.status, null);
  if (!(response.headers.get('Content-Type') ?? '').includes('json')) return null;
  return (await response.json()) as T;
}

/**
 * The index over the collection, which is what makes a budget possible.
 *
 * The map fills the camera's field of view rather than one country, and the
 * files run from 4 kB to Russia's 618 kB — so the client has to know what a
 * country costs before it asks for it, not after. 2.5 kB, once a session.
 *
 * It throws where `fetchSubdivisions` swallows, and the difference is what
 * each absence means. A country with no file is an answer; an index that will
 * not load is this deployment missing its data, and the caller decides what to
 * do about it — which for the map is to fall back to the one country under the
 * middle of the frame, exactly as it behaved before there was an index.
 */
export async function fetchSubdivisionCatalogue(
  options: { signal?: AbortSignal } = {},
): Promise<SubdivisionCatalogue> {
  const catalogue = await publishedJson<SubdivisionCatalogue>(
    `${SUBDIVISIONS}/index.json`,
    options.signal,
  );
  if (catalogue === null) throw new ApiError('The subdivision index is not published', 404, null);
  return catalogue;
}

/**
 * One country's first-level subdivisions, or `null` when it has none.
 *
 * The absence is swallowed on purpose, and it is the whole of the silent
 * fallback. Natural Earth divides 167 of the 177 countries the map draws;
 * for the other ten — Western Sahara, the Falklands, Antarctica, Vanuatu and
 * the disputed entries — there is nothing to draw, and that is an answer, not
 * a failure. Letting it through as a rejected promise would put an error
 * banner on a page whose map is working perfectly.
 *
 * A server error still throws: quietly drawing nothing would hide it.
 */
export function fetchSubdivisions(
  country: string,
  options: { signal?: AbortSignal } = {},
): Promise<SubdivisionsResponse | null> {
  return publishedJson<SubdivisionsResponse>(`${SUBDIVISIONS}/${country}.json`, options.signal);
}
