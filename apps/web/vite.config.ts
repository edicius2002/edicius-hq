import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
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
     */
    css: {
      include: [
        /InvestingPage\.module\.css/,
        /Positions\.module\.css/,
        /AirfarePage\.module\.css/,
        /RouteList\.module\.css/,
        /RouteMap\.module\.css/,
        /RouteDetail\.module\.css/,
        /MoneyWeekChart\.module\.css/,
        /SegmentSummary\.module\.css/,
        /GreenlightPage\.module\.css/,
        /styles\/tokens\.css/,
      ],
    },
    // Shell navigation takes 6.1–6.4s on this repository's /mnt/d drvfs mount,
    // versus 3.2–3.7s on native Linux, and 16.8s in a full parallel run — the
    // routes are code-split, so each first visit compiles a chunk off that
    // mount. The default 5s is a render budget and this is filesystem latency,
    // which is why the whole suite gets the allowance rather than one test.
    // Forty-five seconds holds the four-route walk at its measured worst with
    // room over `ROUTE_LOAD_MS` in `App.test.tsx`, and still fails a hung
    // interaction inside a minute.
    testTimeout: 45_000,
  },
});
