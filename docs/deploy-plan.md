# Deploy plan: frontend on Vercel; passkey-gated API stays home

Decided 2026-09-03 and built since: the Vercel deployment is live, the passkey gate is
on every `/api` route except the four register/login ceremony endpoints, and both transports the API can be published on are commands in
this repository. What remains unverified is listed under Operational evidence and nowhere else.
This document is still the reasoning and not only the runbook, so a later session can
change it without re-deriving why it is shaped this way. Supersedes the original step 7
shape in `IMPLEMENTATION_PLAN.md` §51 ("Cloud: Supabase Auth (magic link), RLS,
deploy"): that assumed multi-user cloud auth, this is single-user personal access
instead.

Revised the same day. The first draft of this document argued for Cloudflare Tunnel
plus Cloudflare Access; that mechanism was ruled out before anything was built, and
the shape it is replaced by answers more of the document's own open questions than it
was chosen to. The reasoning is in "Who can reach the API" and in Operational evidence.

## The shape

- **`apps/web` deploys to Vercel.** It is a static/SPA build; Vercel is a good fit for
  exactly that and nothing else here needs a server process.
- **`services/api` stays on the owner's own PC**, published by Tailscale — to the
  owner's own devices with Serve, or to the internet with Funnel — and not deployed to
  a cloud provider. Which of the two is a runtime setting and not a rebuild; the
  section "Serve and Funnel are one setting" says what each costs and what has to be
  true before the wider one is turned on.
- **Every upstream request leaves the owner's home connection. Always.** This is the
  invariant the shape exists to hold, not a side effect of it: Yahoo, Binance, Google
  Flights and X are reached by `services/api` running on the home PC, from a
  residential address, and by nothing else. The next section is the evidence; the
  section after it lists what the invariant rules out.
- **Access control is a passkey, and Tailscale carries the traffic.** It used to be
  tailnet membership alone. Every `/api` route except the four register/login ceremony endpoints now requires a WebAuthn session, so the question "who may ask" is answered by the application and no longer
  only by what can route to it. The Vercel URL itself stays publicly reachable and
  serves the app shell to anyone who opens it; what they get is the login screen.
  That is accepted, not overlooked: blocking the URL itself would need Vercel
  Deployment Protection on a paid plan, and there is nothing behind it to reach.
  Under Funnel the passkey is not one of two walls but the only one, which is why
  turning Funnel on has an ordering attached to it rather than being a preference.
- **Airfare collection stays home; Supabase is only its indexed read replica.** The
  residential PC retains Google Flights collection and the durable local archive.
  Browser traffic still reaches only this passkey-gated API: Supabase is not a
  collector, browser endpoint, or authentication replacement. See
  [ADR 0003](./ADRs/0003-airfare-supabase-read-store.md).

## Why the API doesn't move to a datacenter

Decision 8.39 in `IMPLEMENTATION_PLAN.md` flagged this before it was checked: "Yahoo
survives a datacenter address; Binance does not. Step 7 must pick its region for
crypto." Decision 10.6 built `scripts/reachability.py` and a `workflow_dispatch`
workflow (`.github/workflows/upstream-reachability.yml`) to check it from a real
GitHub Actions runner rather than assume it.

That run happened on 2026-08-08 (`gh run list --workflow=upstream-reachability.yml`)
and it **failed**:

```
surface                       ms  detail
  yahoo bars         ok         243  HTTP 200
  yahoo search       ok         132  HTTP 200
  yahoo crumb        ok         175  got a crumb
  yahoo quote batch  ok          45  HTTP 200
  yahoo stream       ok        2068  connected and received a frame
  binance bars       fail        59  HTTP 451
  binance stream     fail       366  InvalidStatus: server rejected WebSocket connection: HTTP 451
```

Every Yahoo surface answered, several of them faster than from home (the crumb
handshake, the fragile one, 175ms against 758ms measured from home). Binance answered
**451 to both REST and the socket** — geography, not a quota or a bug. Deploying the
API to any conventional cloud provider (Fly, Railway, a VPS) loses Binance entirely
while Yahoo/equities stay fine, unless something is done about the outbound IP.

Keeping the API on the owner's home connection sidesteps this: 8.39's own baseline,
measured from home, was **all seven surfaces answering**. It's the one deploy shape
that doesn't need to solve the Binance block, at the cost of the API's uptime
depending on a home PC and a home internet connection instead of a datacenter's.

Airfare pins the same address independently. Decision 12.9 in `IMPLEMENTATION_PLAN.md`
records it as a constraint and not a preference: "The collector runs
**locally, on a schedule, from a residential address**. Cloud is deferred, not merely
unbuilt." Google fingerprints datacenter addresses — 8.4's suspicion arriving as a
hard fact — and a Cloud Run job would meet a consent wall, so moving the schedule off
the home PC means changing the fare provider first (AIR-02), not changing a host. Two
independent upstreams, two independent reasons, one address.

That is why the invariant is stated as an invariant. Named consequences, so a later
session does not rediscover them as if they were open:

- Moving `services/api` to Fly, Railway or a VPS is ruled out — measured 451 on both
  Binance surfaces.
- Running a fare collection pass anywhere but the home PC is ruled out — 12.9.
- Putting a cloud worker, proxy or scheduled job "in front of" the upstreams to
  shorten the path is ruled out for the same reason as the first two: that worker's
  outbound address is exactly the datacenter address the probe measured.
- Serving the SPA from a cloud host is _not_ ruled out, because the SPA makes no
  upstream data request of its own. Every upstream call is made by `services/api`.
  (The airline links in `apps/web/src/features/airfare/lib/airlineSearch.ts` are
  navigations the reader clicks in their own browser, not data this app fetches.)

## Who can reach the API

**Tailscale carries the traffic; a passkey session decides who may ask.** Under Serve,
tailnet membership adds a network barrier. Under Funnel, the listener is public and
the passkey is the only access-control barrier.

uvicorn binds `127.0.0.1:8000` in both modes (`scripts/api.mjs:74` and `:86`), the
local `tailscaled` daemon proxies to that loopback address. Serve publishes the
hostname only to devices signed in to the owner's tailnet; Funnel publishes that same
hostname to the internet. The application gate is therefore required in both modes
and is the only gate Funnel can rely on.

**What changed is that it is no longer the only one.** Every route under `/api` except
the four register/login ceremony endpoints requires a live WebAuthn session. The gate
is applied once where the protected routers are included, while authenticated auth
operations carry it on their decorators (`services/api/app/main.py`,
`services/api/app/auth.py`, `services/api/app/routers/auth.py`). `/api/health` is
gated with the rest, so the status indicator reads "API offline" while signed out —
deliberate, and honest, since the API genuinely will not answer that visitor.

**So the API is no longer safe by network alone, and that is the point.** The earlier
version of this section argued that no authentication was correct because there was no
anonymous caller to authenticate. That argument was sound for the shape it described
and it is no longer the shape: the requirement changed to a link that stays public, and
an API whose only defence is that nobody can route to it cannot survive its own
transport being widened. It now survives that.

The inventory below is why any of this matters. It is unchanged from the first draft;
only the mechanism that holds it is. Serve holds it behind both the tailnet and the
passkey; Funnel holds it behind the passkey alone:

- `PUT /api/kv/{key}` and `DELETE /api/kv/{key}` (`services/api/app/routers/kv.py:25`
  and `:30`) — overwrite or delete the owner's stored state. The key allowlist in
  `config.py:5-20` bounds _which_ documents, not who may write them: `portfolio`,
  `finance`, `alert-rules`, `airfare-routes`, `watchlist` and the rest.
- `POST /api/fares/collect` (`routers/fares.py:1088`) — start a collection pass, which
  drives a real Chromium on the home PC and spends requests against Google Flights
  from the residential address the whole shape exists to protect. An anonymous caller
  could burn the one asset that is not replaceable.
- `POST /api/tweets/{handle}/refresh` and `POST /api/tweets/{handle}/watch`
  (`routers/tweets.py:61` and `:97`) — drive the persistent Chromium profile, which
  the watcher requires to hold a logged-in `auth_token` cookie
  (`services/api/app/services/tweet_watcher.py:355-365`). That is the owner's own X
  session being driven by whoever called.
- `POST /api/fares/watch/import` (`routers/fares.py:715`) — upload a file that merges
  into the watched routes and their history.

`CORS_ORIGINS` is configuration, not access control — a browser policy sent in a
response header, which `curl` never asks for. It belongs in the list of things to
configure, not in the list of things that gate access. Neither does restricting the
Vercel deployment help here: the browser calls the `ts.net` hostname directly
(`VITE_API_URL`, `apps/web/src/shared/api/config.ts`), so the API is not behind Vercel
at all.

## Serve and Funnel are one setting

`tailscale serve` publishes a service inside the tailnet; `tailscale funnel` publishes
the same mapping to the entire internet. The distinction is one word on a command line,
which is exactly why it belongs in the record rather than in somebody's memory — and
why both words now live in `scripts/tailnet.mjs` rather than being typed from memory.

It used to be that Funnel must never be run, because it would expose an API with no
authentication at all. **Funnel is possible, and it is built.** The passkey gate is
what makes it so. What replaced the prohibition is an ordering, and the ordering is
still the thing to record: **the login has to be working, verified against a real
enrolled device, before the transport is widened.** Running Funnel first would publish
every write endpoint listed above to the internet for however long it took to notice.

That ordering is now checked and not only written down. `node scripts/tailnet.mjs
funnel` refuses while no enrolled passkey has ever signed in, and it asks the store the
precise question rather than the convenient one: `auth_store.add_credential` writes
`last_used_at: null` and only a verified assertion fills it in, so a credential that
was enrolled and never used does not satisfy it. That distinction is not theoretical —
of the two credentials enrolled on 2026-09-03, one carried a `last_used_at` and one was
still `null`. There is no flag to skip the check; the way past it is to enrol a device
and sign in on it, which is the thing being asked for.

**What Funnel actually changes, and what it does not.** It is a narrower change than it
sounds, and being specific about that is what makes the risk assessable:

- **DNS, which is the whole of "Failed to fetch" on a phone outside the tailnet.** The
  lookup fails before TLS, before CORS, before the API is asked anything. Measured on
  `8.8.8.8`, and the record type matters enough that "NXDOMAIN" on its own is the wrong
  summary: **with Funnel off** there is no `A` record at all and there is an `AAAA`
  pointing at Tailscale's ingress (`2607:f740:f::67`, `::b31`), which the ingress does
  not answer for while the mapping is tailnet-only. **With Funnel on** that inverts —
  `A` becomes `209.177.145.192` and `209.177.145.97`, and the `AAAA` goes. So a phone
  on an IPv4-only mobile network resolves the name only once Funnel is on, which is the
  question the inversion answers and the reason it is written down rather than
  summarised. MagicDNS is unaffected throughout and keeps answering `100.113.213.106`
  on the home PC. Neither record is a tailnet-wide wildcard: an invented node name in
  the same domain is `NXDOMAIN` in both states.
- **Who terminates TLS.** Nobody new. Funnel's ingress forwards the TLS stream to
  `tailscaled` on the home PC, which holds the certificate and decrypts there. The
  paragraph in "What Tailscale and Vercel can see" survives intact, and so does the SSE
  decision below, which depends on exactly this.
- **The hostname the browser calls.** Unchanged, so `VITE_API_URL` is unchanged, so
  **there is no Vercel rebuild in switching transports.** The value is baked at build
  time and it is already the right one; the deployed bundle was read on 2026-09-04 and
  its `getApiBaseUrl` folds to `` `https://pc.tail80c91b.ts.net`.replace(/\/$/, ``) ``.
- **`CORS_ORIGINS`.** Unchanged, and the reason is worth stating because it looks like
  it should change: the `ts.net` name is the API's own origin, the destination of the
  request, and never the `Origin` header on one. What the list holds is where the page
  is served from, which is still Vercel. Verified over the tailnet on 2026-09-04:
  `OPTIONS /api/auth/login/options` with `Origin: https://edicius-hq-web.vercel.app`
  answered 200 with a matching `Access-Control-Allow-Origin`.
- **`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`.** Unchanged, and this is the load-bearing
  one. A passkey is bound to the origin the _page_ came from, not the one the API
  answers on. Under Funnel the page still comes from Vercel, so both values stay
  `edicius-hq-web.vercel.app`, and **every already-enrolled device keeps working with
  no re-enrolment**. The alternative shape — serving the SPA from the `ts.net` host too
  — would move them, and that is discussed under its own heading below because the
  price is not small.
- **Who can reach the write endpoints.** Everyone, subject to the passkey. This is the
  cost and it is not mitigated by anything else: the inventory above answers the
  internet, and `auth.py`'s single 401 for every failure mode is what a stranger gets.
  `/api/auth/register/options` is one of the four routes open by necessity, so the
  eight-character enrolment code is now guessable from anywhere rather than from the
  tailnet — which is why `authorise_code` charging a miss, and killing the code after
  five, stops being an implementation detail and becomes part of the perimeter.

**The SSE query-string token stays sound, and this is the transport change that would
have broken it if it were going to.** The four Server-Sent Events routes accept the
session token in a query string because `EventSource` cannot set request headers, and
`services/api/app/auth.py` records that this is defensible only while TLS terminates on
the owner's own machine. Funnel does terminate there — the ingress forwards an
undecrypted stream to `tailscaled`, which holds the cert — so the token is not written
into anybody else's logs and the decision holds unchanged. The note in `auth.py` already
names Funnel among the transports where it is fine and Cloudflare, ngrok and a Vercel
rewrite as the ones where it is not; that list is correct as written and nothing here
moves the API onto any of the three. `apps/web/src/shared/auth/streamUrl.ts` carries the
same note at the one place every `EventSource` URL is built, and its wording — "there is
no intermediary here: `tailscale serve --https` terminates TLS on the owner's own
machine" — is still true under Funnel, because the sentence turns on where TLS
terminates and not on which of the two commands published the mapping. What Funnel does
change about those four routes is who may attempt them, which is the same thing it
changes about every other route: a stranger can now open the URL and gets the single 401
`auth.py` answers everything with.

**Serving the SPA from the `ts.net` host instead, and why it was not chosen.** Funnel
can carry more than one handler: the web bundle on `/` and the API under `/api` would
collapse the two origins into one, which removes the public Vercel URL, removes CORS
from the picture entirely, and removes the cross-origin question the first draft of
this document spent a paragraph on. It costs three things, and the first is decisive
for the problem actually being solved. **Every enrolled passkey stops working**: the RP
ID would move from `edicius-hq-web.vercel.app` to `pc.tail80c91b.ts.net`, a credential
enrolled under one RP ID is not offered under another, and both existing credentials
would have to be re-enrolled from the PC's own keyboard — including the PC's own, and
including a phone that cannot be enrolled until it can sign in. It is a one-way door in
practice, because moving back refuses whatever was enrolled while it was moved. Second,
the home PC would serve the bundle as well as the API, so the site would be down
whenever the machine is. Third, `VITE_API_URL` would move, and being read at build time
that is a Vercel rebuild — or the end of the Vercel deployment altogether. Funnel over
the existing split is a one-command change that re-enrols nothing; this is a migration.
It is written down because it is the obvious next idea, not because it is wrong.

## What the shape costs in latency

Under the old shape every request went browser → localhost. Under this one it goes
browser → Vercel edge for the bundle, then browser → tailnet → home PC → upstream and
back the same way. The added leg is real and it is on the critical path of every API
call, not just the first.

The added leg is also **variable in a way a tunnel's would not have been**, and that
is the one thing about this shape worth understanding before any figure is quoted.
Tailscale is not a provider's edge sitting between browser and home PC: connections
are peer-to-peer between the owner's own devices, direct wherever a path can be
negotiated and relayed through a DERP server only when it cannot. So there is no
single number to measure. From a laptop on the same LAN as the API the added leg is
close to a local connection and may well be faster than routing through a tunnel's
edge would have been; from a phone on mobile data it is a NAT-traversed path across
the internet, or a DERP relay hop, and it is not the same measurement at all.

What can be said without measuring:

- 8.39's "faster from a runner" figures (crumb 175ms against 758, bars 243 against
  576, the batch 45 against 422) describe the _upstream_ leg only, from a datacenter.
  Under this shape that leg is the home one — the slower column — and the tailnet
  round trip is added on top of it. The probe is evidence about reachability, not a
  latency argument for this shape.
- The home connection's **upstream** bandwidth carries every response body, and
  residential links are asymmetric. `/api/market/quotes` responses are small; a bars
  window and a fare history are not.
- Jitter matters more than the mean here. A home link shares itself with whatever else
  the house is doing, and the client deadlines are finite: 5s by default
  (`apps/web/src/shared/api/http.ts:27`), 15s for market calls
  (`shared/api/market.ts:10`), 20s for fares (`shared/api/fares.ts:20`). The market
  deadline exists because the API already waits on a slow upstream; the added leg eats
  into the same budget from the other end.
- `/api/market/quotes` is swept on a timer, not once: 15s in a regular session, 60s
  while the stream is live (`apps/web/src/features/investing/lib/session.ts:154`).
  Whatever the added leg costs per request is paid at that cadence for as long as a
  tab is open.
- The SSE stream is the opposite case: one long-lived connection, and what matters is
  not per-request latency but whether each frame is forwarded as it is written — an
  open question, listed below.

What would have to be measured, and how — none of these numbers exist yet, so no
figure should be quoted for them until they do:

1. The tailnet leg by itself: `curl -w '%{time_total}'` against `/api/health` through
   the `ts.net` hostname and against `127.0.0.1:8000` in the same minute. The
   difference is the added round trip with no upstream in it.
2. The full path for a real sweep: `/api/market/quotes` with the actual watchlist
   symbol count, over the tailnet and locally, against 8.39's 422ms home baseline for
   the batch. This separates "the tailnet is slow" from "Yahoo from home is slow".
3. Upstream saturation: the same sweep while a fare collection pass is running, since
   the pass is driving a browser on the same connection.
4. Measurement 1 again from a device that is **not** on the same LAN as the API — a
   phone on mobile data. On the LAN the path is direct and short; off it, it is NAT
   traversal or a DERP relay. Those are two different answers and this shape has both,
   so one figure taken beside the machine would describe only half of it.

## What has to be true for this to work

- **`VITE_API_URL`** (read in `apps/web/src/shared/api/config.ts`) has to be set at
  Vercel build time to the API's `ts.net` hostname, not left to its
  `http://localhost:8000` default — that default resolves to _the visitor's own
  machine_ in a deployed build, not the owner's PC, and would fail for everyone but
  the owner running a local API at the same time. It is read at build time, so
  changing it later means a redeploy rather than a restart.
- **`CORS_ORIGINS`** in `services/api/app/config.py:22` defaults to
  `http://localhost:5173,http://127.0.0.1:5173` and needs the Vercel domain added
  (it already reads from an env var of the same name, so this is configuration, not
  a code change). It is required for the browser to accept the responses. It is not
  access control, and nothing in this document should be read as if it were.
- **The owner's PC has to be on and running the API in `serve` mode** —
  `node scripts/api.mjs serve` (`scripts/api.mjs:86`), not `npm run api:dev`. Both
  bind `127.0.0.1:8000`, which is what Serve proxies to, but `dev` adds `--reload`
  (`scripts/api.mjs:74`) and the comment at `scripts/api.mjs:75-85` records why that
  is disqualifying here: on Windows uvicorn switches to a selector event loop whenever
  it runs a subprocess, the reloader included, and that loop cannot spawn one —
  `asyncio.create_subprocess_exec` raises `NotImplementedError`, which is the first
  thing Playwright's driver needs, and is why the tweet watcher never captured
  anything under it. A shape whose whole point is that Playwright runs on this machine
  cannot run the mode that cannot start Playwright. (`npm start` also uses `serve`,
  via `scripts/serve.mjs`, but it starts a local Vite preview alongside it that this
  shape does not need.)
- **Under Serve, Tailscale has to be installed and signed in on every device that
  opens the site**, not only on the home PC, and MagicDNS has to be on so the `ts.net`
  name resolves there. A device without it gets the app shell and no data — and it
  reports that as `Failed to fetch`, because the failure is a DNS lookup and not an
  HTTP status. **Under Funnel this requirement disappears** and is the only reason to
  turn Funnel on: the name is in public DNS, so any device resolves it. Enrolling a
  new phone is the case that forces the choice, since a phone cannot join the tailnet
  and sign in in the same sitting without the owner standing over it twice.
- **Funnel needs no admin-console step on this tailnet.** Checked 2026-09-04 rather
  than assumed: `tailscale status --json` reports this node's `Self.CapMap` already
  carrying `funnel` and
  `https://tailscale.com/cap/funnel-ports?ports=443,8443,10000`, and HTTPS
  certificates are already enabled — `CertDomains` lists `pc.tail80c91b.ts.net` and
  Serve has been answering on a real certificate. So the whole of enabling it is
  `npm run tailnet:funnel` on the home PC.
- **This is the real cost of the shape**: no uptime beyond whenever the machine is up,
  no restart-on-crash beyond whatever the owner does by hand.
- **The Vercel project is configured by `vercel.json` at the repository root**, which
  now exists. The workspace root is the repo root (`package.json`
  `workspaces: ["apps/*"]`), the build is `npm run build -w web` (`package.json:18`),
  and the output is `apps/web/dist`. The app uses `createBrowserRouter`
  (`apps/web/src/app/router/createAppRouter.ts:6`) over real paths — `/dashboard`,
  `/finance`, `/greenlight`, `/investing`, `/airfare`, `/sentiment`
  (`apps/web/src/app/router/routes.tsx`) — so a deep link or a refresh on any of
  them needs a rewrite to `index.html` or it 404s at the edge. `vercel.json` supplies
  that rewrite explicitly, which is why whether Vercel's Vite preset would have
  supplied it is no longer a question this document has to answer.

## Sentiment upstream and cache

`GET /api/sentiment` is covered by the same passkey gate as the other data routes. The API, not the browser, first requests CNN's public JSON at `https://production.dataviz.cnn.io/index/fearandgreed/graphdata`. If and only if CNN answers 403/418, it requests the public no-key mirror at `https://fearandgreedgraph.com/api/fear-greed`. Both adapters validate the complete aggregate-plus-seven-indicator document and write the same normalized snapshot atomically to `services/api/.local-data/sentiment/snapshot.json` (or the equivalent path below `LOCAL_DATA_DIR`). That file is a disposable market-data cache, not user state or an archive. The response source is `cnn` or `cnn-mirror`, and the latter is attributed in the page.

A snapshot is fresh for four hours. Concurrent misses share one upstream request. If a transient network, rate-limit, 5xx, 403 or 418 response prevents refresh, a valid snapshot younger than seven days is returned with `stale: true`; older, incomplete or malformed data is refused. No scheduled collector is needed: the first authenticated read after expiry refreshes it, and the web client does no background polling.

The integration deliberately sends only `Accept: application/json`. A terminal request from the home environment returned HTTP 418 during implementation, while the public JSON resource and schema were independently observable. Do not add browser-identifying headers, forge `Origin`/`Referer`, replay cookies or scrape rendered HTML to work around that refusal. The fallback's published contract says daily history with hourly refresh; the deployment-host probe confirmed the general ISO `asOf`, epoch-millisecond indicator timestamps and all nine underlying series needed for eight charts. At most 366 points per series are returned. A malformed response, a non-refusal CNN failure, or failure of both paths returns an error (or the labelled stale snapshot while eligible).

## How it is run

One command for the API, and one for the transport it is published on.

- `node scripts/api.mjs serve` — the API on `127.0.0.1:8000`, without the reloader
  that cannot start Playwright.
- `npm run tailnet:serve` — publishes it inside the tailnet over HTTPS
  (`tailscale serve --bg --https=443 localhost:8000`). `--bg` is what makes it outlive
  the terminal; without it the command holds the foreground and the service stops when
  the window closes.
- `npm run tailnet:funnel` — publishes the same mapping to the public internet
  (`tailscale funnel --bg --https=443 localhost:8000`), after refusing if no enrolled
  passkey has ever signed in. This is the one command in the repository that makes
  something reachable from outside the house, which is why it prints what it did.
- `npm run tailnet:status` — prints the full `https://<machine>.<tailnet>.ts.net` URL
  and, on the same line, whether it says `(tailnet only)` or names a public one. That
  string is what `VITE_API_URL` is set from, and it is stable across restarts and
  across the Serve/Funnel choice — which is the property a quick tunnel could not
  offer and the reason switching transports is not a rebuild.
- `npm run tailnet:off` — takes it back down, from either setting
  (`tailscale serve --https=443 off`).

Everything above is `scripts/tailnet.mjs`, in the subcommand shape `scripts/api.mjs`
already uses. It is a separate file because every mode of `api.mjs` ends in
`spawnSync(python, args)` and `tailscale` has no interpreter to pin.

**Going from Funnel back to Serve is `off` and then `serve`, in that order.** Not
`tailscale funnel --https=443 off`, which sounds like the narrowing command and is not:
measured 2026-09-04, run against a mapping that was tailnet-only it exited 0 and left
`tailscale serve status` reporting `No serve config` — it removes the handler rather
than the public flag. The two-step is the one that cannot leave anything published
halfway through.

The full first-time setup, including the admin-console steps and the order to verify
them in, lives in the implementation plan for this work rather than here.

## Airfare replica operator runbook

This procedure applies the accepted read-replica design in
[ADR 0003](./ADRs/0003-airfare-supabase-read-store.md). The importer identity,
manifest, replay, and report-target protections are specified in
[the synchronization contract](./airfare-sync-contract.md). It does not authorize
collection relocation, archive/backup/ledger/state/catalog deletion, Storage upload,
or `db reset --linked`.

### Authorization and stable-source gate

Task 9 changes a hosted schema and rows, creates a server credential, and may write
local sync cursors. Stop here until the owner separately authorizes the target check,
interactive CLI link, credential creation, scheduled-collector pause/resume, `db push`,
and every `--apply`/`--incremental` command. Do not treat this runbook as that
authorization.

Before the first scan, identify active API, scheduled, and manual collectors; confirm
that no pass is running; and create a stable source window only with owner approval.
Do not resume collection or mutate the source while comparing the before/after source
manifests below. The standard production source is literal and repository-relative:

```powershell
$source = 'services/api/.local-data'
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Expected the approved Airfare source directory: $source"
}
```

Do not substitute the worktree's empty root `.local-data` directory or an unverified
`LOCAL_DATA_DIR`. Reports must live outside this source tree. The CLI preserves
report-target anti-overwrite protection and serializes this standard source as
`services/api/.local-data`; an external source is deliberately reported only as
`<external-source>`, never as an absolute path.

### Target, schema, and credential gate

Use the pinned CLI for every Supabase operation. A global executable is not a
substitute. The following target check is externally read-only, but it does not
authorize later mutations:

```powershell
npx --yes supabase@2.105.0 projects list
```

Stop unless the human-visible target is exactly `edicius-hq`, ref
`abndifkxpfppmllgxfnu`, region `sa-east-1`, and `ACTIVE_HEALTHY`. With the owner
present to enter any database password only at the prompt, link and review the one
approved migration:

```powershell
npx --yes supabase@2.105.0 link --project-ref abndifkxpfppmllgxfnu
npx --yes supabase@2.105.0 migration list
npx --yes supabase@2.105.0 db push --dry-run
```

Stop if the linked project/ref differs or the preview contains anything other than
`20260915000000_airfare_archive.sql`. Do not reset a database to make the list match.
After the owner accepts that preview, create a dedicated project-specific `sb_secret_*`
key in the Supabase dashboard and set only these names in ignored repository-root
`.env`; never display their values or create `services/api/.env`:

```dotenv
SUPABASE_URL=
SUPABASE_SECRET_KEY=
AIRFARE_DATA_BACKEND=local
AIRFARE_SYNC_ENABLED=false
```

Use only non-revealing checks:

```powershell
git check-ignore -v -- .env
git status --short --ignored -- .env
git diff --cached -- .env
```

The expected status form is `!! .env`; the cached diff must be empty. Then apply and
re-list only the reviewed migration:

```powershell
npx --yes supabase@2.105.0 db push
npx --yes supabase@2.105.0 migration list
```

### Backfill, reconciliation, and idempotency gate

All commands run from repository root. They write reports under the repository's
`docs/` tree or the already-absolute `$env:TEMP`; never use `../../docs`.

```powershell
npm run fares:supabase -- --dry-run --source $source --report "$env:TEMP/airfare-source-before.json"
npm run fares:supabase -- --apply --full --source $source --report "$env:TEMP/airfare-first-full.json"
npm run fares:supabase -- --verify --source $source --report "$env:TEMP/airfare-first-verify.json"

# Idempotency is destination-manifest equality before and after the replay.
npm run fares:supabase -- --verify --source $source --report "$env:TEMP/airfare-second-before.json"
npm run fares:supabase -- --apply --full --source $source --report "$env:TEMP/airfare-second-full.json"
npm run fares:supabase -- --verify --source $source --report "$env:TEMP/airfare-second-after.json"
npm run fares:supabase -- --dry-run --source $source --report "$env:TEMP/airfare-source-after.json"
```

Every command must exit zero. The `uploaded` field counts attempted upserts; it is not
evidence that the second full pass inserted zero records. Instead compare the complete
manifest results, including source stability and the before/after destination manifest:

```powershell
$sourceBefore = (Get-Content -Raw "$env:TEMP/airfare-source-before.json" | ConvertFrom-Json).source | ConvertTo-Json -Depth 12 -Compress
$sourceAfter = (Get-Content -Raw "$env:TEMP/airfare-source-after.json" | ConvertFrom-Json).source | ConvertTo-Json -Depth 12 -Compress
$verifyBefore = Get-Content -Raw "$env:TEMP/airfare-second-before.json" | ConvertFrom-Json
$verifyAfter = Get-Content -Raw "$env:TEMP/airfare-second-after.json" | ConvertFrom-Json
$destinationBefore = $verifyBefore.destination | ConvertTo-Json -Depth 12 -Compress
$destinationAfter = $verifyAfter.destination | ConvertTo-Json -Depth 12 -Compress
if (-not $verifyBefore.matches -or -not $verifyAfter.matches -or $sourceBefore -ne $sourceAfter -or $destinationBefore -ne $destinationAfter) {
  throw 'Backfill or idempotency verification did not preserve matching manifests.'
}
```

Stop on a nonzero exit; any mismatch; an invalid/all-invalid source; a new or
unexplained skipped record; an unstable source; an unexpected migration; an attempt to
reset; or a report containing a secret, header, password, URL query credential, raw
fare, or absolute source path. Preserve the failure report without staging it and do
not retry through an unexplained mismatch.

An accepted, safe evidence envelope must retain the first verification outcome, the
second before/after destination equality, source/destination counts and digests,
skipped-record disposition, and incremental result without raw payloads or local paths.
The current final `--verify` report alone does not retain that idempotency proof. Do
not stage `docs/airfare-supabase-backfill-report.json` until that envelope is available
and its exact JSON has been reviewed. It must use the safe repo-relative source label.

After the owner accepts the frozen-source reconciliation, one incremental catch-up and
the safe final verification report may be run:

```powershell
npm run fares:supabase -- --apply --incremental --source $source --report "$env:TEMP/airfare-catch-up.json"
npm run fares:supabase -- --verify --source $source --report docs/airfare-supabase-backfill-report.json
```

Inspect the exact staged report before committing it; it may contain only aggregate
metadata, manifests, and the approved evidence envelope. Resume normal collection only
through the owner-approved procedure. A successful backfill or catch-up never permits
source deletion.

### Canary, read rollback, and retention

Do not enable live replication or Supabase reads until Tasks 5–7 are accepted, the
bounded watched-month parity command and safe configured-backend canary exist, and the
Task 9 source/destination and idempotency gates above have succeeded. The older direct
model measurement is not an authenticated cloud canary and must not be relabelled as
one.

With separate owner approval for flag edits, API restarts, real Google Flights traffic,
and the failure drill, begin in local-read mode by setting the two ignored runtime
values shown above to `AIRFARE_SYNC_ENABLED=true` and `AIRFARE_DATA_BACKEND=local`,
then restart through the established production command:

```powershell
node scripts/api.mjs serve
```

`npm run fares:collect` sends real upstream requests and writes local collection,
spend, and pass state; never use it as a harmless probe or use `--all` merely to force
data. A post-collection verification, all-watched-route parity check, and the same
safe canary must all pass before changing `AIRFARE_DATA_BACKEND=supabase`.

Once the bounded-read comparison has been extended and accepted, its repository-root
invocation is:

```powershell
npm run fares:supabase -- --compare-reads --source $source --report "$env:TEMP/airfare-read-parity.json"
```

It must emit only route labels, equality results, counts, and canonical digests; any
mismatch blocks cutover. The outage drill must use a syntactically valid nonexistent
HTTPS `*.supabase.co` host in that drill process's environment, exercise authenticated
history and calendar reads, confirm the structured local-fallback event, then stop the
drill process and restore the normal URL. It must not change committed/example
configuration or run collection.

After the safe canary, parity, failure drill, and read rollback have all succeeded,
run the full repository gate before accepting a cutover:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run lint:api
npm run typecheck:api
npm run test:api
npx --yes supabase@2.105.0 test db
```

The read rollback is one flag: set `AIRFARE_DATA_BACKEND=local`, restart the API, and
verify the local endpoint. If replication must stop too, set
`AIRFARE_SYNC_ENABLED=false` separately and restart when configuration is read only at
startup. Preserve logs and both copies during either action. Do not delete or truncate
local JSONL/JSON, wipe cursors, reset the linked database, delete remote rows/tables,
or silently substitute an empty remote result for an outage.

## What Tailscale and Vercel can see

Stated factually, because the shape is chosen and this is what choosing it means.

With `tailscale serve --https`, **TLS terminates on the owner's own machine.** Traffic
between the owner's devices is WireGuard-encrypted end to end — direct where a path
can be negotiated, and relayed through a DERP server where it cannot, which forwards
ciphertext it cannot read. **No third party sees request contents.** This is a
straight improvement over the tunnel shape the first draft assumed, and it is recorded
as one rather than left implicit: that draft had to accept a provider reading, at its
edge and in the clear, which KV documents were written and what was in them, which
symbols were watched, and which origin/destination/date pairs were priced. None of
that is visible to anyone now.

What Tailscale does see is coordination metadata: which devices exist, what they are
named, when they connect, and which peers talk to which. Not URLs, not bodies.

One real cost, and it is the one thing this shape gives away. Enabling HTTPS
certificates publishes the machine's name to public **Certificate Transparency logs**.
The tailnet name and the machine name become public strings — permanently, and
searchably — even though nothing they serve does. It is worth choosing a machine name
before enabling this rather than after.

**Funnel changes one line of the above and not the rest.** The traffic still terminates
on the owner's machine: Tailscale's Funnel ingress forwards the TLS stream without
holding a key for it, and `tailscaled` on the home PC decrypts. So "no third party sees
request contents" survives the switch, and so does the SSE query-string token that
depends on it. What Funnel adds is that the machine's `ts.net` name goes into public
DNS as well as into the CT logs it was already in — the name was already a public,
searchable string, and it becomes a resolvable one. It also adds Tailscale's ingress to
the metadata list: connection times and traffic volumes for the requests that arrive
from outside the tailnet, which under Serve did not exist. And the address a request
arrives from is no longer necessarily the owner's: anyone on the internet can reach the
listener, and what refuses them is `auth.py`'s single 401.

Vercel sees the site: page loads, asset requests, the deployment's own logs. It does
not see API traffic, because the browser calls the `ts.net` hostname directly rather
than a Vercel rewrite. That stays true only as long as no proxy rewrite is introduced
to work around CORS — worth remembering, because such a rewrite would put a third
party back in the middle of every API call and undo the paragraph above.

The exposure is not "data leaves the house": it already does, to Yahoo and Google. It
is what a second party can observe continuously rather than per-upstream. Under Serve
the honest answer to that is much less than it would have been under a tunnel: device
names and connection times, and nothing about what was asked for.

## Operational evidence still open

- **Do all four SSE streams survive Tailscale Serve and Funnel?**
  `/api/market/stream` is server-sent
  events, not a WebSocket: `@router.get("/stream")` returning a `StreamingResponse`
  with `media_type="text/event-stream"` (`services/api/app/routers/market.py:338`,
  `:388`). This repo's WebSockets are outbound, to Yahoo and Binance
  (`services/api/app/adapters/yahoo_stream.py`, `binance_stream.py`), and never
  traverse it — so "does it support WebSockets" is the wrong question. The right ones
  are whether the proxy buffers the response and whether it drops an idle connection.
  The code already mitigates both and the mitigations are what should be tested:
  `X-Accel-Buffering: no` is set on the response (`routers/market.py:393`), and a
  silent interval emits a `: keep-alive` comment frame (`routers/market.py:382`,
  `services/api/app/services/sse.py`) at `KEEPALIVE_SECONDS = 20.0`
  (`services/api/app/services/stream_hub.py:47`). What changed with the shape is only
  what the proxy is: a `tailscaled` running on the same machine as the API rather than
  a provider's edge in another country. That makes buffering less likely and leaves it
  unmeasured. Hold a `curl -N` on each stream through both Serve and Funnel and confirm
  the keep-alives arrive on time and unbuffered. The complete set is
  `/api/market/stream`, `/api/fares/collect/stream`,
  `/api/fares/calendar/collect/stream` and `/api/tweets/{handle}/stream`; the latter
  three are implemented in `routers/fares.py` and `routers/tweets.py` and use the same
  framing.
- **Does the site work from a phone?** The transport is answered and measured; the
  ceremony on the phone is the owner's report rather than a measurement here. The owner
  tried to enrol a phone that had not joined the tailnet on 2026-09-04 and the attempt
  answered `Failed to fetch` — not CORS and not the passkey, but the DNS lookup
  described above. Funnel was turned on the next day and the public path was then
  verified from this machine, forcing `curl --resolve` onto the Funnel ingress
  addresses so MagicDNS could not answer instead: `GET /api/auth/session` returned
  **401 through both ingress addresses** with a valid certificate in about 1.1s, and an
  `OPTIONS /api/auth/login/options` carrying the Vercel origin returned 200 with a
  matching `Access-Control-Allow-Origin`. That is the phone's exact path, taken from a
  keyboard. The owner then reported the phone working. **What is still not measured
  here is the WebAuthn ceremony itself** — the RP ID against a real platform
  authenticator, the ten-minute code typed on a handset — which has been exercised by
  the owner and by nothing this document can point at.

Four things that were open in earlier drafts are not open any more, recorded here so
the change is visible rather than silent.

**Whether fare collection runs on the home PC** is settled by decision 12.9 and by the
invariant in "The shape": it does, and it may not run anywhere else. **Whether the
tunnel supports WebSockets** was the wrong question, answered above.

**What authenticates the API** is settled in code: a passkey session gates every
`/api` route except the enrolment and login ceremony routes. Serve is tailnet-only;
Funnel is public, so network membership is not authentication. The first draft's client-credentials paragraph — the
cross-origin cookie change it wanted on `fetch` and on every `EventSource`, and the
header key an `EventSource` cannot send — is deleted rather than deferred: no cookie
crosses any origin under this shape, so none of it applies. (That paragraph was also
wrong on its own terms. It said "both streams" for what are four `EventSource` call
sites in three files, missing `apps/web/src/shared/api/tweets.ts:68`.)

**Cloudflare Tunnel or ngrok** is answered with neither. Cloudflare Access was the
first choice and it cannot be built here: Access protects a hostname inside a
Cloudflare zone the owner has added to their account, and the owner has no domain and
wants no recurring cost. A `trycloudflare.com` quick tunnel answers on Cloudflare's
domain rather than the owner's, so no Access policy can attach to one, and its URL
changes on every restart — which would force a Vercel rebuild each time the PC came
up, because `VITE_API_URL` is read at build time. Tailscale Serve is free on the
personal plan, needs no domain, and its hostname is auto-generated and stable across
restarts. This is written down so a later session does not reopen it.

**Whether Vercel's Vite preset rewrites unknown paths to `index.html`** stopped
mattering: `vercel.json` states the rewrite explicitly, so the answer is the same
either way.
