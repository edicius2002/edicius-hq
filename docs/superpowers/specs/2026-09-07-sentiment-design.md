# Sentiment Design

**Status:** Approved for implementation by the request's explicit auto-approve.

## Outcome

Add a sixth, independent top-level product area named **Sentiment** at `/sentiment`.
It replaces the earlier INV-06/Pulse decision that placed these panels inside Investing.
The page shows CNN's Fear & Greed composite and the seven published inputs: Market
Momentum, Stock Price Strength, Stock Price Breadth, Put and Call Options, Market
Volatility, Safe Haven Demand, and Junk Bond Demand. Each metric has a current
0–100 score and classification, its provider timestamp, and a historical chart.

## Source and cadence evidence

CNN's page is rendered from the public JSON resource
`https://production.dataviz.cnn.io/index/fearandgreed/graphdata`. The resource was
observable as `application/json` on 2026-09-07, although the editorial HTML page is
blocked from automated reading by `robots.txt`. CNN does not publish a supported API
schema.

A recent independent one-shot schema capture documents the same top-level resource and
shows:

- an ISO timestamp on `fear_and_greed`;
- epoch-millisecond timestamps and about 250 daily market observations on histories;
- the seven requested metrics plus two reference series (`market_momentum_sp125` and
  `market_volatility_vix_50`);
- a sample provider timestamp of `23:59:55Z` on a market day.

References:

- [CNN JSON resource](https://production.dataviz.cnn.io/index/fearandgreed/graphdata)
- [Observed schema capture](https://github.com/qte77/analyze-stock-kpi/blob/main/docs/cnn-fg-api.md)

The data therefore has daily market resolution even though CNN may recompute near the
close. The API caches a successful normalized snapshot for **4 hours**, limiting an
active instance to at most six upstream refreshes per day. The web query uses the same
4-hour freshness and does not poll in the background. A valid expired disk snapshot may
be served for at most **7 days** after a transient timeout, connection failure, 5xx,
429, 403, or 418 response. This carries a Friday close across a long weekend and reports
`stale: true`; it never turns absent data into a fabricated reading.

An unauthenticated terminal probe received CNN's explicit 418 anti-bot response. The
adapter sends only an honest JSON `Accept` header and does not imitate a browser, add a
false `Referer`, solve challenges, or retry aggressively. After a 403/418 only, it uses
Fear & Greed Graph's public no-key JSON mirror, which publishes aligned daily aggregate
and component histories with hourly refresh. The page attributes this transport path;
malformed CNN data and non-refusal failures are not hidden behind it.

## API architecture

`app.adapters.cnn_sentiment` owns the upstream schema. It validates finite numeric
values, known ratings, timezone-aware timestamps, ordered histories, and all required
blocks. It normalizes provider-specific keys into typed domain objects. Synthetic test
fixtures model the complete relied-on shape; no live response is versioned.

The normalized contract is:

```text
SentimentSnapshot
  source: "cnn" | "cnn-mirror"
  fetchedAt: ISO UTC timestamp
  asOf: ISO UTC timestamp
  stale: boolean
  composite: SentimentMetric
  indicators: SentimentMetric[7]

SentimentMetric
  key, label
  score: number (0..100)
  classification: extreme fear | fear | neutral | greed | extreme greed
  timestamp: ISO UTC timestamp
  series: SentimentSeries[]

SentimentSeries
  key, label, unit
  points: { timestamp: ISO UTC timestamp, value: finite number,
            classification?: classification }[]
```

Composite has one `score` series. Momentum has S&P 500 and its 125-day moving average;
Volatility has VIX and its 50-day moving average. Each other indicator has one raw-value
series. The metric's current `score` must not be presented as the latest raw history
value: they have different scales.

`SentimentCache` stores one atomic normalized JSON document under
`.local-data/sentiment/snapshot.json`, coalesces concurrent refreshes, and records fetch
time independently of CNN's observation time. Corrupt or structurally obsolete files
are cache misses. A successful refresh replaces the file atomically. A transient
provider error can return a bounded stale snapshot; malformed successful payloads are
explicit errors and do not overwrite the previous snapshot.

`GET /api/sentiment` is mounted with the same `GATED` dependency as every private router.
It maps upstream errors to a structured 502/503/429 response and returns the normalized
wire model on success.

## Web architecture

`shared/api/sentiment.ts` is the only browser-facing data contract and request function.
`useSentiment` wraps it with TanStack Query and a four-hour `staleTime`.

`SentimentPage` renders:

1. a page header naming CNN as the source and the observation time;
2. an explicit stale warning when `stale` is true;
3. a headline panel for the composite;
4. a responsive grid containing the seven indicator panels.

The grid is two columns where space permits and one column on narrow screens. Loading,
empty, first-load error, and stale states have distinct copy and semantics. A Retry
button refetches after an error. No placeholders contain sample numbers.

`SentimentChart` is one reusable SVG chart rendered eight times. It calculates an honest
domain from all lines in the metric, draws labelled x/y axes, a text-and-stroke legend,
and a crosshair that snaps to an observed timestamp. Pointer, touch, Arrow keys, Home,
and End reach the same readings. An `aria-live` readout and a collapsible data table make
the graph values available without vision or a pointer.

The crosshair reuses the project's established SVG pattern: dashed vertical/horizontal
hairlines, a marked observation and a nearby tooltip. Its position eases with a short CSS
transform transition; `prefers-reduced-motion: reduce` removes the transition. The pure
letterbox-aware pointer conversion moves from the Airfare feature into `shared/lib` so
Sentiment, Airfare, and Greenlight use one implementation without cross-feature imports.

## Failure behavior

- No cache + timeout/refusal/malformed JSON: API error; page shows an alert and Retry.
- Valid response with no usable history: parser rejects it as malformed; no invented
  point or score is shown.
- Expired cache + transient failure within seven days: API returns the old snapshot with
  `stale: true`; page keeps all charts and warns with the actual `asOf` time.
- Expired cache older than seven days: API error, not an indefinitely fossilized chart.
- One malformed required metric invalidates the refresh so eight internally consistent
  charts are always delivered together.

## Testing and release

Backend tests cover complete parsing, units/reference lines, duplicate ordering,
malformed values, timeouts/status mapping, fresh cache, refresh cadence, concurrent
coalescing, corrupt files, stale fallback, the endpoint contract, and session gating.
Frontend tests cover the API client, route/nav/drawer, all eight chart headings, loading,
empty, stale and error states, pointer and keyboard crosshair behavior, responsive CSS
contracts, and reduced-motion CSS. Existing Airfare/Greenlight crosshair tests protect
the shared-geometry move.

Required gates are format, lint, typecheck, backend tests, frontend tests, and production
build. Hardware acceleration is not used; charts are DOM/SVG.

## Out of scope and limitations

- No multi-year archival collector; the provider's rolling history is shown as received.
- No intraday polling or scheduled background job.
- No browser impersonation or bypass for CNN's anti-bot controls; the attributed public
  mirror is a separate provider dependency.
- No investment recommendations or derived scores. The mirror's composite rating is
  mapped from its published bands (`[0,25)`, `[25,45)`, `[45,55)`, `[55,75)`,
  `[75,100]`) because that public JSON exposes the reading but not a top-level rating
  field.
- CNN can change or withdraw this undocumented resource; typed failures and stale data
  contain the blast radius but cannot make the source supported.
