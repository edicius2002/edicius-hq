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
