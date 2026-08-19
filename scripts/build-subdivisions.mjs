/**
 * First-level subdivisions, one TopoJSON file per country, for the route map.
 *
 * Run rarely — Natural Earth publishes a few times a decade — and never as
 * part of a build, which is why the two packages it needs are not repository
 * dependencies. From the repository root:
 *
 *     npm install --no-save topojson-server@3 topojson-simplify@3
 *     node scripts/build-subdivisions.mjs
 *
 * `--no-save` rather than `npx --package=`, which does not work here: it puts
 * the packages somewhere only CommonJS `require` looks, and Node's ESM
 * resolver ignores it. `topojson-client` and `d3-geo` come from `node_modules`
 * already; the web app depends on both.
 *
 * **Why this is served and not bundled.** Decision 12.24 chose the 1:110m
 * world because 1:50m is 236 kB gzipped and too heavy to ship to a browser.
 * There is no 1:110m admin-1 at all, and Natural Earth's 1:50m admin-1 covers
 * nine countries — Russia, the United States, India, Indonesia, China, Brazil,
 * Canada, Australia and South Africa — and nobody else, so 1:10m is the only
 * worldwide option and it is 40 MB of GeoJSON. Split per country and served
 * from this repository's own API, a reader downloads one country when they
 * zoom into it and the web bundle does not grow at all.
 *
 * **Why only the internal borders survive.** A country's coastline is already
 * on screen, drawn from the bundled 1:110m outlines, and a second coastline
 * four hundred times finer sitting on top of it would not agree with the first.
 * So each country's subdivisions are meshed at build time with
 * `(a, b) => a !== b`, which keeps the boundaries between two subdivisions and
 * throws the outer edge away. It is also where nearly all the bytes were:
 * Chile's file is 6.7 kB of Andean borders where the whole polygon set was
 * 96 kB, almost all of it fjord.
 *
 * The labels are computed here rather than in the browser for the same reason:
 * with the polygons gone there is nothing left to take a centroid of, and the
 * centroid is of the largest piece — `countries.ts` gives the reason, which is
 * that averaging a country's islands in lands the label offshore.
 *
 * Source: Natural Earth 1:10m Admin 1 – States, Provinces, via
 * github.com/nvkelso/natural-earth-vector. Public domain: "All versions of
 * Natural Earth raster + vector map data found on this website are in the
 * public domain… No permission is needed to use Natural Earth. Crediting the
 * authors is unnecessary." Verified at naturalearthdata.com/about/terms-of-use
 * and in the repository's own LICENSE.md on 2026-08-19.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoArea, geoCentroid } from 'd3-geo';
import { meshArcs, quantize } from 'topojson-client';
import { presimplify, simplify, sphericalTriangleArea } from 'topojson-simplify';
import { topology } from 'topojson-server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'services', 'api', 'app', 'data', 'subdivisions');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'natural-earth');

const SOURCES = {
  admin1: 'ne_10m_admin_1_states_provinces',
  admin0: 'ne_110m_admin_0_countries',
};
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/**
 * How much detail a border keeps, as the area in steradians of the smallest
 * triangle a retained vertex may make with its neighbours.
 *
 * Derived from the tightest view this map allows rather than chosen by eye.
 * Zoom stops at 8x and the stage is at least 460px on its short side, so the
 * globe's radius never exceeds a few thousand pixels: at 0.42 x 460 x 8 that
 * is 1546px, one screen pixel is 1/1546 rad, and a pixel of ground is 4.1 km.
 * At 1e-8 the retained vertices average 4.0 km apart — about a pixel at the
 * closest anyone can get. Halving it to 2e-9 buys 2.8 km spacing, which no
 * view can resolve, and costs 26% more on disk.
 *
 * For scale: the 1:110m national borders these lines sit inside have a median
 * segment of 63 km, so a subdivision border is already fifteen times the
 * detail of the country border around it.
 */
const SIMPLIFY = 1e-8;

/**
 * Coordinates per axis after quantization, across each country's *own* extent.
 *
 * Per file rather than worldwide, which is what makes one constant right for
 * both Peru and Russia: 1e4 steps across Peru's 12 degrees of longitude is
 * 130m, and across Russia's 170 degrees it is 1.9 km — in both cases finer
 * than the simplification above has already left the geometry.
 */
const QUANTIZE = 1e4;

async function source(name) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${name}.geojson`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    process.stdout.write(`fetching ${name}…\n`);
    const response = await fetch(`${BASE}/${name}.geojson`);
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    const text = await response.text();
    writeFileSync(file, text);
    return JSON.parse(text);
  }
}

/**
 * The biggest single piece of a subdivision, which is where its name belongs.
 *
 * The same rule `airfare/lib/countries.ts` applies to a country, for the same
 * reason: a whole-shape centroid averages the outlying islands in and puts the
 * label off the land it names.
 */
function mainland(geometry) {
  if (geometry.type === 'Polygon') return geometry;
  let best = { type: 'Polygon', coordinates: geometry.coordinates[0] ?? [] };
  let biggest = -1;
  for (const rings of geometry.coordinates) {
    const piece = { type: 'Polygon', coordinates: rings };
    const size = geoArea(piece);
    if (size > biggest) {
      biggest = size;
      best = piece;
    }
  }
  return best;
}

/**
 * The mesh's own arcs, renumbered so every arc the mesh does not use can go.
 *
 * `meshArcs` returns indices into the whole topology, and the whole topology
 * is mostly coastline this file has no use for — for Chile that is 93% of the
 * arcs. There is no published helper for dropping them, and leaving them costs
 * fourteen times the bytes.
 */
function onlyMeshArcs(topo, meshed) {
  const used = new Set();
  for (const line of meshed.arcs) for (const index of line) used.add(index < 0 ? ~index : index);
  const order = [...used].sort((left, right) => left - right);
  const renumbered = new Map(order.map((old, index) => [old, index]));
  return {
    type: 'Topology',
    objects: {
      borders: {
        type: meshed.type,
        arcs: meshed.arcs.map((line) =>
          line.map((index) => (index < 0 ? ~renumbered.get(~index) : renumbered.get(index))),
        ),
      },
    },
    arcs: order.map((index) => topo.arcs[index]),
  };
}

const [admin1, admin0] = await Promise.all([source(SOURCES.admin1), source(SOURCES.admin0)]);

/*
 * Natural Earth's admin-1 names its country in three-letter codes; the map
 * knows a country by the numeric ISO 3166-1 code `world-atlas` uses as a
 * feature id. Admin-0 carries both, so it is the join. `ISO_N3_EH` rather than
 * `ISO_N3` because Natural Earth writes -99 into the latter for France and
 * Norway, whose sovereign entries hold the code instead.
 */
const numericOf = new Map();
for (const country of admin0.features) {
  const { ADM0_A3: a3, ISO_N3_EH: numeric } = country.properties;
  if (a3 && numeric && !numeric.startsWith('-')) numericOf.set(a3, numeric);
}

/*
 * Only countries the map can actually draw. A country `world-atlas` does not
 * carry as its own shape has no name on this map to hand over from, so a file
 * for it could never be asked for.
 */
const drawable = new Set(
  JSON.parse(
    readFileSync(path.join(ROOT, 'node_modules', 'world-atlas', 'countries-110m.json'), 'utf8'),
  ).objects.countries.geometries.map((shape) => shape.id),
);

const byCountry = new Map();
for (const unit of admin1.features) {
  const id = numericOf.get(unit.properties.adm0_a3);
  if (!id || !drawable.has(id)) continue;
  if (!byCountry.has(id)) byCountry.set(id, []);
  byCountry.get(id).push(unit);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let total = 0;
let written = 0;
let bordersless = 0;
for (const [id, features] of [...byCountry].sort(([left], [right]) => left.localeCompare(right))) {
  const simplified = simplify(
    presimplify(
      topology({ subdivisions: { type: 'FeatureCollection', features } }),
      sphericalTriangleArea,
    ),
    SIMPLIFY,
  );
  const meshed = meshArcs(simplified, simplified.objects.subdivisions, (a, b) => a !== b);
  /*
   * A country whose first level is one unit — Monaco, Singapore, the Falklands
   * — has no border between two of anything, and its one name would only
   * repeat the country's. No file, and the map falls back to the country name
   * it already had.
   */
  if (meshed.arcs.length === 0) {
    bordersless += 1;
    continue;
  }

  const body = {
    country: id,
    borders: quantize(onlyMeshArcs(simplified, meshed), QUANTIZE),
    labels: features
      .map((unit) => ({
        name: unit.properties.name ?? unit.properties.name_en ?? null,
        // Four decimals is about 11m, well inside the error of a centroid
        // taken from a simplified outline, and it halves the label bytes.
        at: geoCentroid(mainland(unit.geometry)).map((degree) => Math.round(degree * 1e4) / 1e4),
        area: Number(geoArea(unit.geometry).toExponential(4)),
      }))
      .filter((label) => label.name)
      // Biggest first, which is the order `withoutOverlaps` wants: when two
      // names land on the same patch of screen the bigger place keeps it.
      .sort((left, right) => right.area - left.area),
  };

  const text = `${JSON.stringify(body)}\n`;
  writeFileSync(path.join(OUT, `${id}.json`), text);
  total += Buffer.byteLength(text);
  written += 1;
}

const files = readdirSync(OUT).length;
process.stdout.write(
  `${written} countries, ${files} files, ${(total / 1024).toFixed(0)} kB; ` +
    `${bordersless} skipped for having no internal border\n`,
);
