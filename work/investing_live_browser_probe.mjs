// Local-only measurement harness. Set MARKET_PROBE_URL, MARKET_PROBE_OWNER and MARKET_LIVE_KEY.
// The test owner must already exist in the test database.
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { streamMarket } from '../api/market/live.ts';

const url = process.env.MARKET_PROBE_URL;
const owner = process.env.MARKET_PROBE_OWNER;
const key = Buffer.from(process.env.MARKET_LIVE_KEY ?? '', 'base64');
if (!url || !owner || key.length !== 32) throw new Error('Missing probe configuration');
const ui = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { '@': resolve('apps/web/src') } },
  define: {
    'import.meta.env.VITE_DATA_BACKEND': '"neon"',
    'import.meta.env.VITE_MARKET_LIVE_ENABLED': '"true"',
    'import.meta.env.VITE_NEON_DATA_API_URL': '"https://fixture.neon.tech/rest/v1"',
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.MARKET_PROBE_PORT ?? 35173),
    strictPort: true,
    hmr: false,
  },
  plugins: [
    {
      name: 'market-browser-probe',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/work/investing_live_browser_probe.tsx"></script>',
            );
            return;
          }
          if (!req.url?.startsWith('/api/market/live?')) return next();
          const abort = new AbortController();
          res.on('close', () => abort.abort());
          const response = await streamMarket(
            new Request(new URL(req.url, 'http://localhost'), { signal: abort.signal }),
            owner,
            url,
            key,
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) Readable.fromWeb(response.body).pipe(res);
          else res.end();
        });
      },
    },
  ],
});
await ui.listen();
console.log('Market probe listening on loopback');
