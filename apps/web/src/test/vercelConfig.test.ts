import { describe, expect, it } from 'vitest';

import VERCEL_CONFIG_SOURCE from '../../../../vercel.json?raw';

/*
 * `vercel.json` lives at the repository root, not in this workspace, because
 * the Vercel project's root directory is the repository root — npm workspaces
 * need the root `package.json` to install `web`'s dependencies at all.
 *
 * It is asserted from here because these three values are agreements with
 * files this suite already owns: the build script in the root `package.json`,
 * Vite's default output directory, and the router's use of real paths. Changing
 * either side without the other is silent until a deploy 404s.
 *
 * Read through Vite's `?raw` query rather than `node:fs`, which is what the
 * stylesheet tests in this suite already do with `?inline`. Nothing else under
 * `src` imports a Node builtin: `tsconfig.app.json` types this workspace as
 * `["vite/client"]`, so a `readFileSync` here fails `typecheck` and `lint`
 * rather than the deploy it is meant to protect. `vite/client` declares
 * `*?raw`, so the text arrives typed and the config stays browser-only.
 */
type VercelConfig = {
  buildCommand?: string;
  outputDirectory?: string;
  rewrites?: { source: string; destination: string }[];
};

function readVercelConfig(): VercelConfig {
  return JSON.parse(VERCEL_CONFIG_SOURCE) as VercelConfig;
}

describe('vercel.json', () => {
  it('builds the web workspace from the repository root', () => {
    expect(readVercelConfig().buildCommand).toBe('npm run build -w web');
  });

  it('publishes the directory Vite actually writes', () => {
    expect(readVercelConfig().outputDirectory).toBe('apps/web/dist');
  });

  it('rewrites unknown paths to the SPA entry point', () => {
    // Every route below `/` is client-side, so a deep link or a refresh has to
    // reach `index.html` rather than a file that was never built.
    expect(readVercelConfig().rewrites).toContainEqual({
      source: '/(.*)',
      destination: '/index.html',
    });
  });
});
