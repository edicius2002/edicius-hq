/**
 * The transport the API is published on, and the one command that widens it.
 *
 * `tailscale serve` publishes the API to the owner's own devices; `tailscale
 * funnel` publishes the same mapping to the entire internet. One word apart on
 * a command line, and the second one is the difference between "a phone that
 * has joined the tailnet can sign in" and "every write endpoint in
 * `docs/deploy-plan.md`'s inventory answers the public internet, gated by a
 * Supabase JWT and nothing else". That is too large a difference to leave in
 * somebody's shell history, so both settings live here, spelled out, beside
 * the check that says which of them is allowed yet.
 *
 * **Why this is not a mode in `scripts/api.mjs`.** That file is a dispatcher
 * for the API's own interpreter: every one of its modes ends in
 * `spawnSync(python, args)`, and the comment above `PY_TARGETS` records why —
 * a check that runs against whatever Python is on PATH passes on one machine
 * and fails on another. `tailscale` is a binary with no interpreter to pin, so
 * adding it there would mean making the one uniform thing about that file
 * conditional. Same subcommand shape, different executable, separate file.
 */

import { spawnSync } from 'node:child_process';
const MODES = ['serve', 'funnel', 'status', 'off'];

const mode = process.argv[2];
if (!MODES.includes(mode)) {
  console.error(`Usage: node scripts/tailnet.mjs <${MODES.join('|')}>`);
  process.exit(1);
}

/*
 * Both numbers are pinned rather than configurable, and neither is arbitrary.
 *
 * 8000 is where `scripts/api.mjs` binds uvicorn — `--port 8000` in both `dev`
 * and `serve` — so a port option here would only be a way of pointing the
 * tailnet at nothing.
 *
 * 443 because Funnel is not allowed on an arbitrary port: this node's own
 * capability list, read from `tailscale status --json` on 2026-09-04, carries
 * `https://tailscale.com/cap/funnel-ports?ports=443,8443,10000` and no others.
 * Of those three, 443 is the only one that gives a URL with no port in it, and
 * the URL matters more here than usual: it is baked into the web bundle at
 * build time (`VITE_API_URL`, `apps/web/src/shared/api/config.ts`), so moving
 * the API to 8443 later is a Vercel redeploy rather than a restart.
 */
const API_PORT = 8000;
const HTTPS_PORT = 443;

const TARGET = `localhost:${API_PORT}`;

/**
 * Whether uvicorn is answering on the loopback address Serve and Funnel proxy to.
 *
 * A warning and never a refusal. The Tailscale mapping is configuration, not a
 * connection — it is legitimate to set it up before starting the API, and it
 * survives the API restarting under it. What is not legitimate is finding out
 * from a phone: a mapping pointed at a dead port answers 502 from `tailscaled`
 * with nothing in it that names this machine, which is a long way to travel to
 * learn that `node scripts/api.mjs serve` is not running. Measured 2026-09-05,
 * once with Funnel already on: uvicorn was down, `127.0.0.1:8000` refused the
 * connection outright, and every path above it — the tailnet name and both
 * public ingress addresses — answered `502 Bad Gateway` with `Content-Length:
 * 0`. An empty 502 is the same answer a misconfigured mapping would give, which
 * is exactly why this warning is worth its four lines.
 *
 * Any HTTP status counts, including the 401 that a signed-out `/api/health`
 * correctly returns — the question is whether something is listening, not
 * whether this script may talk to it.
 */
async function apiIsAnswering() {
  try {
    await fetch(`http://127.0.0.1:${API_PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function tailscale(args) {
  const result = spawnSync('tailscale', args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not run tailscale: ${result.error.message}`);
    console.error('Install Tailscale and make sure `tailscale` is on PATH.');
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (mode === 'status') {
  // `funnel status` prints the same table as `serve status` and adds the one
  // fact this script exists to make visible: whether the mapping says "tailnet
  // only" or names a public URL.
  tailscale(['funnel', 'status']);
  process.exit(0);
}

if (mode === 'off') {
  /*
   * Takes the mapping down entirely, whichever of the two settings it was on.
   *
   * This is the form the CLI itself suggests after a successful `serve`, and
   * it is deliberately not the way back from Funnel to Serve. Measured on
   * 2026-09-04: `tailscale funnel --https=443 off`, run against a mapping that
   * was tailnet-only, exited 0 and left `tailscale serve status` reporting
   * `No serve config` — it deletes the handler rather than narrowing it. To go
   * from public back to tailnet-only, run `off` and then `serve`; that
   * sequence cannot leave anything published at any point in the middle, and
   * it was run the same day against the live mapping, which came back with a
   * byte-identical `tailscale serve status --json`.
   */
  tailscale(['serve', `--https=${HTTPS_PORT}`, 'off']);
  process.exit(0);
}

if (!(await apiIsAnswering())) {
  console.warn(`Warning: nothing is answering on http://127.0.0.1:${API_PORT}.`);
  console.warn('Start it with `node scripts/api.mjs serve` or the mapping will proxy to nothing.');
}

if (mode === 'serve') {
  // `--bg` is what makes it outlive this process; without it the command holds
  // the foreground and the mapping goes when the window closes.
  tailscale(['serve', '--bg', `--https=${HTTPS_PORT}`, TARGET]);
  process.exit(0);
}

/*
 * Funnel from here down.
 *
 * Every API route is verified by the Supabase JWT gate before a handler runs.
 * Funnel changes the transport's audience, not the API authorization contract,
 * so it no longer reads a PC-backed credential store before widening access.
 */
tailscale(['funnel', '--bg', `--https=${HTTPS_PORT}`, TARGET]);

console.log(`\nThe API is now on the public internet, on port ${HTTPS_PORT}.`);
console.log('Every /api route answers anyone who asks; the Supabase JWT gate is what refuses');
console.log('them. Enabling this also publishes the ts.net name of this machine to public');
console.log('DNS, which is what lets a phone that has never joined the tailnet resolve it.');
console.log('\nTake it back down with: node scripts/tailnet.mjs off\n');
