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
import { mergeArcs, meshArcs, quantize } from 'topojson-client';
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
 * Derived from the tightest view this map allows. Zoom stops at 32x (12.164)
 * and the stage is at least 460px on its short side, so the globe's radius
 * never exceeds 0.42 x 460 x 32 = 6182px, one screen pixel is 1/6182 rad, and
 * a pixel of ground is 1.03 km.
 *
 * **The source runs out before we do, and that is the finding here.** Measured
 * over the five report countries with no simplification and no quantization at
 * all, raw 1:10m Natural Earth has a mean segment of 2.61 km and a median of
 * 1.62 km — 2.5 and 1.6 pixels at 32x. There is no threshold that reaches one
 * pixel, because the vertices do not exist. So this is set just above the
 * floor rather than at a target: 1e-9 leaves the coastline at 2.51 km against
 * the source's own 2.45 km, 2% coarser for 0.39 MB less on disk, where 1e-8 —
 * which was right when zoom stopped at 8x — gives 3.28 km, a third worse and
 * plainly faceted at this scale.
 *
 * Internal borders sit at 3.60 km against a source floor of 3.36 km. They read
 * coarser than the coast and mostly should: a long straight run on the Peru
 * side of the Amazon, or along a US state line, is a border that genuinely is
 * straight, not a curve that has been flattened.
 */
const SIMPLIFY = 1e-9;

/**
 * How coarse a quantization step is allowed to be on the ground, in degrees.
 *
 * `quantize` divides a topology's own bounding box into a fixed number of
 * steps, so one constant count means one thing for Peru's 12 degrees and quite
 * another for Russia's 170: at 1e4 steps Peru rounds to 130m and Russia to
 * 1.9 km, and at 32x that second figure is nearly two pixels of error on top
 * of geometry that only has 1.6 km of detail to begin with. The step count is
 * therefore derived per country from its own extent, so what is held constant
 * is the thing that matters — half a pixel of ground at the closest zoom this
 * map allows, which at 1.03 km per pixel is about 0.005 degrees.
 */
const QUANTIZE_DEGREES = 0.005;

/** Never fewer steps than this, so a tiny country is not quantized to nothing. */
const MIN_QUANTIZE = 1e3;

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
 * The arcs these objects actually use, renumbered so every other one can go.
 *
 * `meshArcs` and `mergeArcs` return indices into the whole topology, and the
 * whole topology holds every unit's full outline. There is no published helper
 * for dropping the unused ones, and leaving them in costs several times the
 * bytes — for the internal borders alone that was fourteen times.
 */
function onlyUsedArcs(topo, objects) {
  const used = new Set();
  const walk = (arcs) => {
    if (typeof arcs[0] === 'number') for (const index of arcs) used.add(index < 0 ? ~index : index);
    else for (const nested of arcs) walk(nested);
  };
  for (const object of Object.values(objects)) if (object.arcs.length) walk(object.arcs);

  const order = [...used].sort((left, right) => left - right);
  const renumbered = new Map(order.map((old, index) => [old, index]));
  const renumber = (arcs) =>
    typeof arcs[0] === 'number'
      ? arcs.map((index) => (index < 0 ? ~renumbered.get(~index) : renumbered.get(index)))
      : arcs.map(renumber);

  const kept = {};
  for (const [name, object] of Object.entries(objects)) {
    if (!object.arcs.length) continue;
    kept[name] = { type: object.type, arcs: renumber(object.arcs) };
  }
  const arcs = order.map((index) => topo.arcs[index]);
  // Its own extent, not the one it was cut out of: `quantize` divides the
  // bounding box it is handed, so a stale one would spend half its steps on
  // geometry that is no longer in the file.
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const arc of arcs)
    for (const [longitude, latitude] of arc) {
      if (longitude < bbox[0]) bbox[0] = longitude;
      if (latitude < bbox[1]) bbox[1] = latitude;
      if (longitude > bbox[2]) bbox[2] = longitude;
      if (latitude > bbox[3]) bbox[3] = latitude;
    }
  return { type: 'Topology', bbox, objects: kept, arcs };
}

/**
 * How many quantization steps this country's own extent earns.
 *
 * See `QUANTIZE_DEGREES`: what is held constant is the ground a step covers,
 * not the number of steps, so Peru is not stored a hundred times finer than
 * Russia for no reason and Russia is not stored two pixels coarse.
 */
function stepsFor(topo) {
  const [west, south, east, north] = topo.bbox;
  const span = Math.max(east - west, north - south);
  return Math.max(MIN_QUANTIZE, Math.ceil(span / QUANTIZE_DEGREES));
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
   * The country's own outline, dissolved out of the units that tile it.
   *
   * Not a second download and not a second source: the admin-1 units of a
   * country cover it exactly, so merging them *is* the national outline, at
   * the same 1:10m as the borders drawn inside it. Taking it from
   * `countries-50m` instead was the obvious move and is wrong twice over —
   * 1:50m is a 5 km resolution where 32x reads 1.03 km to the pixel, and a
   * 1:50m coast under 1:10m provincial borders would not meet them, leaving
   * every coastal province hanging off the edge of its own country.
   */
  const merged = mergeArcs(simplified, simplified.objects.subdivisions.geometries);
  /*
   * A country whose first level is one unit — Monaco, Singapore, the Falklands
   * — has no border between two of anything, and its one name would only
   * repeat the country's. No file, and the map keeps the country name and the
   * bundled 1:110m outline it already had.
   */
  if (meshed.arcs.length === 0) {
    bordersless += 1;
    continue;
  }

  const pruned = onlyUsedArcs(simplified, { borders: meshed, land: merged });
  const body = {
    country: id,
    borders: quantize(pruned, stepsFor(pruned)),
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
