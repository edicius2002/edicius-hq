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
    // versus 3.2–3.7s on native Linux; a full drvfs run has reached 20.9s while
    // workers contend for that mount. Thirty seconds covers both without making a hung interaction wait a minute.
    testTimeout: 30_000,
  },
});
