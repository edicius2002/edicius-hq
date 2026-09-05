import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/*
 * Three `.test.ts` files that look like pure logic and are not: they reach for
 * something only a browser environment has, so they run in the `dom` project
 * with the `.tsx` files rather than in `node` with their own extension.
 * `streamUrl` and `http` read `localStorage`/`sessionStorage`; `alertSound`
 * constructs an `AudioContext`. Listing them here rather than renaming them to
 * `.tsx` keeps the extension meaning what it says — no JSX in the file.
 */
const BROWSER_TESTS = [
  'src/shared/auth/streamUrl.test.ts',
  'src/shared/api/http.test.ts',
  'src/features/investing/lib/alertSound.test.ts',
];

/*
 * A few stylesheets are compiled for real; every other one is still
 * replaced by the usual class-name proxy.
 *
 * jsdom lays nothing out and evaluates no container query, so the Investing
 * breakpoint — the width at which the chart and the watchlist stop sharing
 * a row — is invisible to every test that renders the page. It was wrong
 * for exactly that reason and nothing went red. `workspaceBreakpoint.test`
 * reads the compiled text instead and checks the threshold against the
 * widths it is derived from, which needs the text to survive as far as the
 * test. `Positions.module.css` joined it for the same reason: the width one
 * position card is given decides how many fit across the panel, and jsdom
 * can see neither. The Airfare files joined them for the third case of the
 * same thing: whether the watchlist's rows scroll inside the row they
 * share with the map turns entirely on `contain: size`, which jsdom does
 * not implement and which was already wrong once on the Investing page for
 * exactly that reason. Two more followed, each for a height that lives in
 * a stylesheet and is asserted in a test. `RouteMap.module.css` carries
 * `a-taller-row-is-four-more-routes`: the stage's `min-height` is the only
 * height in that row, so how many watched routes fit without a scrollbar
 * is a number in *that* file and the two beside it, and `routesScroll`
 * cannot check the sum with a third of it missing. `RouteDetail.module.css`
 * carries the route strip's reserves, and a height reserved in `calc()`
 * against the font sizes in the same file is exactly the kind of
 * arithmetic that drifts out of step with the rules it came from without
 * any test noticing. `MoneyWeekChart.module.css` is the seventh and the
 * same case as `Positions`: how many month boxes sit in a row and how many
 * week cards sit across a month are two track counts in that file, and
 * jsdom lays out neither. `SegmentSummary.module.css` is the eighth, for
 * the third track count in the same panel, and `GreenlightPage.module.css`
 * came with it: the height that panel reserves for the first two segment
 * cards is arithmetic over lengths that live in `SegmentSummary`, and a
 * reserve computed from another file's font sizes drifts the moment either
 * moves. Scoped to these files so no other suite changes behaviour.
 *
 * Both projects below get this list, and the `node` one needs it as much as
 * the `dom` one: `routesScroll`, `positionsGrid`, `workspaceBreakpoint`,
 * `moneyWeekGrid` and `segmentGrid` are all `.test.ts` and all fail without
 * it. Measured — they fail on the `?inline` import returning a proxy, not on
 * anything about the environment they run in, so moving them to node changed
 * nothing about why they need this.
 *
 * These same `?inline` imports are a blind spot for `vitest --changed`:
 * edit one of these `.module.css` files and `--changed` selects only the
 * files it can see as changed *inputs*, not the tests that read the
 * compiled string through this query. Measured by editing
 * `RouteMap.module.css` and running `--changed` — it picked up
 * `RouteMap.test.tsx` but not `routesScroll.test.ts`, which imports that
 * same file this way (`import MAP_SOURCE from './RouteMap.module.css?inline'`)
 * and fails without it. `--changed` is reliable for TS/TSX and for
 * `setup.ts` — measured separately, it re-selects the full 137/137 suite
 * for a `setup.ts` edit — so this gap is narrow, but touching any file in
 * the list below calls for a full run, not `--changed`.
 */
const CSS_INCLUDE = [
  /InvestingPage\.module\.css/,
  /Positions\.module\.css/,
  /AirfarePage\.module\.css/,
  /RouteList\.module\.css/,
  /RouteMap\.module\.css/,
  /RouteDetail\.module\.css/,
  // The month strip: six tracks and twelve children are what make it two
  // rows, and the height those two rows cost is what `routesScroll`
  // spends against the map. Neither is observable from the rendered tree.
  /RouteEditor\.module\.css/,
  /MoneyWeekChart\.module\.css/,
  /SegmentSummary\.module\.css/,
  /GreenlightPage\.module\.css/,
  // The tenth, and the first whose counterpart is not a stylesheet:
  // `narrowBreakpoint.test` checks this file's phone-scale threshold against
  // `NARROW_QUERY` in `useIsNarrow.ts`, because the shell decides in JavaScript
  // whether to show a drawer and this page decides in CSS whether its header is
  // at phone scale. A viewport between the two numbers gets one answer and the
  // other layout, and jsdom evaluates neither.
  /FinancePage\.module\.css/,
  // The eleventh, and the third side of the same seam as the tenth. The shell
  // drops its side gutters at the width `NARROW_QUERY` hands the navigation to
  // a dropdown, so the threshold now lives in three files that cannot see each
  // other. `narrowBreakpoint.test` also checks that the narrow rule takes only
  // the *inline* padding: four pages lift their top edge with a negative margin
  // sized against the block padding, and cutting that would pull them under the
  // top bar. jsdom evaluates neither the query nor the margin.
  /AppShell\.module\.css/,
  /styles\/tokens\.css/,
];

/*
 * Spread into both projects rather than left to `extends: true` alone. The
 * inheritance would probably carry them, but a `testTimeout` that silently
 * reverts to the 5s default is the kind of thing that shows up as a flake
 * weeks later, and these are three lines.
 */
const sharedTestOptions = {
  globals: false,
  // Shell navigation takes 6.1–6.4s on this repository's /mnt/d drvfs mount,
  // versus 3.2–3.7s on native Linux, and 16.8s in a full parallel run — the
  // routes are code-split, so each first visit compiles a chunk off that
  // mount. The default 5s is a render budget and this is filesystem latency,
  // which is why the whole suite gets the allowance rather than one test.
  // Forty-five seconds holds the four-route walk at its measured worst with
  // room over `ROUTE_LOAD_MS` in `App.test.tsx`, and still fails a hung
  // interaction inside a minute.
  testTimeout: 45_000,
  css: { include: CSS_INCLUDE },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    watch: {
      usePolling: true,
    },
  },
  test: {
    // The default forks pool opens one process per logical core — up to
    // eleven on a twelve-core machine — each with its own jsdom. Run this
    // suite alongside anything else memory-hungry (another dev server,
    // another suite, an agent or two) and some of those forks fail to start
    // at all: vitest reports `Timeout starting forks runner` and the run ends
    // at `Test Files no tests` — zero tests executed, not tests failing. That
    // is a memory-arrival problem, not a slow one, so it needs a ceiling, not
    // a faster runner. Six is half the logical cores, chosen only to keep
    // that ceiling under whatever else is running; it is not a speed
    // recommendation. Measured on this repo, wall time across worker counts
    // varied 96s–163s under load with no clean relationship to the number of
    // workers, so retune this by measuring on an idle machine, not by
    // reasoning about it. `poolOptions.forks.maxForks` is the same setting
    // under its pre-v4 name, still honoured at runtime but no longer in
    // vitest 4's types — `maxWorkers` is what `InlineConfig` declares now.
    //
    // It is a pool-wide ceiling, so it stays at the root and is shared across
    // both projects rather than granted to each of them.
    maxWorkers: 6,
    /*
     * Two projects because most of this suite was paying for a browser it
     * never touched.
     *
     * Of 614.85s of worker time in a full run, 474.64s — 77% — was not tests
     * at all: environment, setup, import and transform, which come to a fixed
     * 3.37s per file against the 0.84s the average file spends actually
     * running its tests. The 88 `.test.ts` files carry 69% of the tests and
     * 20% of the test time, and almost all of them are pure functions over
     * plain data. Measured over exactly those files, jsdom plus `setup.ts`
     * cost 43.93s and node with no jsdom cost 16.05s.
     *
     * The split is by extension because that is what the extension already
     * means here: `.tsx` renders components and needs a DOM, `.ts` does not.
     * `BROWSER_TESTS` above is the three-file exception list.
     *
     * The node project loads `setup.node.ts`, not `setup.ts`. That is not only
     * because most of `setup.ts` is jsdom patching: it cannot run in node at
     * all. `class PointerEventStub extends MouseEvent` is evaluated inside the
     * `typeof PointerEvent === 'undefined'` branch, node always enters that
     * branch, and node has no `MouseEvent` — `ReferenceError` before a single
     * test starts. `setup.node.ts` carries over the one piece that is worth as
     * much here as there: the `fetch` that rejects, so a debounced write
     * escaping after a test cannot reach the developer's own API.
     */
    projects: [
      {
        extends: true,
        test: {
          ...sharedTestOptions,
          name: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...BROWSER_TESTS],
          environment: 'node',
          setupFiles: ['./src/test/setup.node.ts'],
        },
      },
      {
        extends: true,
        test: {
          ...sharedTestOptions,
          name: 'dom',
          include: ['src/**/*.test.tsx', ...BROWSER_TESTS],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
});
