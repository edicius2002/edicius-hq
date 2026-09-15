import { build } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const webRequire = createRequire(path.resolve(root, '../../apps/web/package.json'));
const { default: react } = await import(
  pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href
);
await build({
  configFile: false,
  root,
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(root, '../../apps/web/src') } },
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/') },
  build: { outDir: path.resolve(process.argv[2]), emptyOutDir: false },
});
