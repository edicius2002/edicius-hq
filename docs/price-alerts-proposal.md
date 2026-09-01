# Price alerts for Investing — design proposal

Scope: `apps/web/src/features/investing/` (`chart/`, `data/`, `hooks/`, `lib/`, `ui/`) and what it
uses of `apps/web/src/shared`. Airfare, Finance and Dashboard are out of scope.

This is a design document, not an implementation. No production code was changed.

Already decided (not re-opened here): notification is a toast + a sound, no browser
`Notification` API, no backend price watcher. Alerts must be visible on the chart.

## 1. Data model

```ts
// apps/web/src/features/investing/data/priceAlerts.ts
export type AlertDirection = 'above' | 'below';

export type PriceAlert = {
  id: string;             // crypto.randomUUID() — see below for why this needs an id
  symbol: string;
  direction: AlertDirection;
  price: number;
  active: boolean;
  repeat: boolean;        // false = fires once, then deactivates. true = re-arms (§3).
  createdAt: number;
  lastTriggeredAt: number | null;
};

export type AlertRules = { version: 1; alerts: PriceAlert[] };
export const EMPTY_ALERT_RULES: AlertRules = { version: 1, alerts: [] };
```

**Why an `id`, unlike `Position`/`WatchlistEntry`.** `data/portfolio.ts:18-24` and
`data/watchlist.ts:13-17` both key their row by `symbol` — one position, one watchlist entry, per
symbol. Alerts explicitly can't work that way: the brief requires "several alerts on the same
symbol" (e.g. AAPL above 220 *and* AAPL below 190 at once), so `symbol` cannot be the row's
identity. An `id` per alert is the smallest change that supports that; `crypto.randomUUID()` is
already the id source used elsewhere in the app (`apps/web/src/features/finance/hooks/useFinanceData.ts:54`).

**Why `repeat` as a boolean, not richer scheduling.** The brief asks for "one-shot or repeatable,"
nothing more (no cooldown windows, no daily reset). A boolean is the whole requirement; anything
richer is speculative. `repeat: true` does **not** mean "fire on every tick past the threshold" —
see §3 for what it actually re-arms on.

**Why `active` is separate from `repeat`.** `active` is the toggle the UI exposes directly
("pause this alert without deleting it"). A one-shot alert also sets `active: false` automatically
once it fires — that's the mechanism, not a second flag; it reuses the same field the user already
controls, exactly the way the store already treats `edit()` results (`useStoredDocument.ts:110-113`
short-circuits when the returned value doesn't change, so flipping `active` on fire is a normal
edit, not a special path).

## 2. Persistence

Follow `data/portfolio.ts` + `hooks/usePortfolio.ts` exactly — pure transition functions in
`data/`, a thin hook wrapping `useStoredDocument` in `hooks/`. Nothing new to invent:

- `normalizeAlertRules(value): AlertRules` — same shape as `normalizePortfolio` (`data/portfolio.ts:50-74`)
  and `normalizeWatchlist` (`data/watchlist.ts:36-62`): reject anything that isn't the right
  shape, drop rows that fail their own field checks, never crash on bad storage.
- `addAlert`, `updateAlert`, `removeAlert`, `toggleAlert`, `alertsFor(rules, symbol)` — pure
  functions over `AlertRules`, tested the way `portfolio.test.ts`/`watchlist.test.ts` test theirs.
- `hooks/usePriceAlerts.ts` — a `useStoredDocument<AlertRules>({ key, normalize, placeholder })`
  wrapper, structured identically to `hooks/usePortfolio.ts:27-76`: `store.edit(...)` for every
  mutation, nothing in the hook decides anything.

**The storage key is already reserved.** `apps/web/src/shared/storage/keys.ts:5` lists
`'alert-rules'` in `STORAGE_KEYS`, and nothing in the repo currently reads or writes it
(`grep` across `apps/web/src` turns up only that one line). This looks like exactly this feature
was anticipated when the key list was drawn up. No change to `keys.ts` is needed — `usePriceAlerts`
just uses `'alert-rules'` as its `key`, the same way `usePortfolio` uses `PORTFOLIO_KEY`.

The write path (debounced writes, serialized edits, refusal to write over a failed read,
flush-on-`pagehide`/hidden) is entirely `useStoredDocument`'s (`useStoredDocument.ts:68-180`) —
nothing alert-specific needs to be built there.

## 3. Detecting a *cross*, not a level

**Where quotes already flow.** `InvestingPage.tsx` builds one merged price map per render,
`bySymbol` at `InvestingPage.tsx:158` (`applyTicks(swept, [...ticks.values()])`), fed by the REST
sweep (`quotes` query, `InvestingPage.tsx:118-123`) and the SSE tick stream
(`hooks/useQuoteStream.ts`, opened via `data/quoteStream.ts:119-138`). Every symbol the page cares
about already lands in that one map, coalesced to one render per animation frame
(`useQuoteStream.ts:95-116`). Alert evaluation should read `bySymbol`, not open a second
subscription — it's the same reasoning `usePortfolio`'s valuations already follow
(`portfolio.ts:148-164`, called from `InvestingPage.tsx:181-189` against the same map).

**Why `lib/latch.ts` is not the piece to reuse — but its shape is.** `latch.ts` is a rise-fast /
fall-slow boolean with a grace period, purpose-built for connection liveness
(`latch.ts:1-19` explains exactly why: so a flapping SSE connection can't starve the sweep
interval). A price alert wants the opposite of hysteresis-by-time: a cross should fire on the tick
it happens, not after some grace period. So `latch`'s actual state machine doesn't fit. What's
worth copying is its *discipline*: a small, pure, explicitly-transitioned state value
(`latch.ts:37-50`, `make()` returning a new `Latch` per transition), fed real inputs (`now`) so it
can be unit-tested without React or a browser, and consumed from a hook via a `useState`/`useRef`
(`useQuoteStream.ts:39`, `120`, `130`). `lib/latch.test.ts` is the template for how the new
cross-detector should be tested.

**The actual mechanism — `lib/alertCross.ts` (new file):**

```ts
export type Side = 'above' | 'below';

export function sideOf(price: number, threshold: number): Side {
  return price >= threshold ? 'above' : 'below';
}

// One alert, one known previous side, one new price → does it fire, and what's the next side.
export function crossed(alert: PriceAlert, previousSide: Side | null, price: number):
  { fired: boolean; nextSide: Side } {
  const nextSide = sideOf(price, alert.price);
  if (previousSide === null) return { fired: false, nextSide }; // seed only — see reload, §7
  const enteredZone =
    (alert.direction === 'above' && previousSide === 'below' && nextSide === 'above') ||
    (alert.direction === 'below' && previousSide === 'above' && nextSide === 'below');
  return { fired: enteredZone, nextSide };
}
```

A one-shot alert fires once and then `active` flips to `false` (§1), so it can never fire again
without the user re-enabling it. A repeatable alert keeps tracking `nextSide` after firing: it only
fires again once the price has gone back to the *other* side and crossed back — never once per
tick while sitting past the threshold. That "don't re-fire while still on the alarm side" property
is exactly what `previousSide`/`nextSide` tracking gives for free; no debounce timer needed.

**Where the state lives.** `previousSide` per alert id is transient — it belongs in a `useRef<Map<string, Side>>`
inside a new `hooks/useAlertEvaluator.ts`, evaluated in a `useEffect` keyed on `bySymbol` (and the
alert list), the same shape `useQuoteStream`'s `discardTicksBefore` (`useQuoteStream.ts:45-70`)
uses a functional `setTicks` update. It is **not** persisted to storage — see §7 on reload.

## 4. Drawing the alert line on the chart

**The mapping already exists.** `lib/scales.ts:136-139`, `priceScale(range, plot)`, turns a price
into a y pixel via a `d3-scale` linear scale over `priceRange(shown)` (`scales.ts:113-134`).
`chart/CandleChart.tsx`'s `drawChart` already uses exactly this to draw the grid and axis labels —
`CandleChart.tsx:505` computes `scale = priceScale(range, pricePlot)`, then `CandleChart.tsx:511-524`
walks `priceTicks(range, pricePlot)` and for each one does `scale(price)` → draws a horizontal
line → labels it in the right gutter. That loop is the template for an alert line: same
`scale(alertPrice)` call, dashed instead of solid, colored by direction, labeled with the
threshold instead of a round tick number.

The closer analogue is actually `chart/indicatorLayers.ts`'s `drawRsi` (`indicatorLayers.ts:227-257`):
dashed horizontal guide lines (`RSI_GUIDES = [30, 70]`, `indicatorLayers.ts:192`) computed from a
value→y mapping (`valueToY`, over the RSI band) with a label drawn at the right edge
(`label(ctx, ..., band)`, `indicatorLayers.ts:306-310`). An alert line is the same drawing, just
against the price scale/band instead of the RSI 0–100 one.

**Integration point.** Add `alerts?: PriceAlert[]` to `CandleChartProps` (`CandleChart.tsx:57-73`),
thread it into `DrawArgs` (`CandleChart.tsx:478-487`) and the `drawChart` call
(`CandleChart.tsx:175`), and add a new `drawAlertLines(ctx, { alerts, scale, plot, band: layout.price })`
in `indicatorLayers.ts`, called from `drawChart` — most naturally right after the candle loop
(after `CandleChart.tsx:582`, alongside where `drawPane` is called for the panes at
`CandleChart.tsx:584-599`) so an alert line is never hidden under a candle body, the same reason
`drawOverlays` is called *before* the candles at `CandleChart.tsx:546` while RSI/MACD guides draw
in their own clipped band on top.

This belongs on the lower canvas (`candleRef`, repainted on data/window/size change,
`CandleChart.tsx:163-176`), not the crosshair canvas (`overlayRef`, repainted on every pointer
move, `CandleChart.tsx:178-191`) — an alert line only moves when the price scale's range changes
(panning/zooming) or an alert is edited, not on every mouse move.

**Edge case: alert price outside the visible range.** `priceScale` is a `d3-scale` linear scale,
which extrapolates outside its domain rather than clamping — `scale(alertPrice)` for a price far
above or below what's currently on screen returns a y outside `[0, plot.height]`. `drawAlertLines`
must skip (or clip) any line whose y falls outside the plot, or it will draw into the axis gutter
or off-canvas. `priceRange` (`scales.ts:113-134`) already includes a padding term (`padding = 0.06`)
worth reusing as the "how far outside counts as still-relevant" margin, rather than a hard cutoff
at the plot edge.

**⚠️ Conflict with worker2.** worker2 is concurrently editing `CandleChart.tsx` to draw a position
line (this is presumably the average-cost line for whichever symbol is charted, likely via the
exact same `scale(price)` technique in the exact same `drawChart` function). This proposal does
**not** implement the chart layer for that reason — flagging the integration point only. Whoever
lands second should expect a merge conflict in `drawChart`/`DrawArgs`/`CandleChartProps`, and it
would be worth factoring both as one shared `drawPriceLines(ctx, { lines: {price, color, label,
dash?}[], scale, plot, band })` helper in `indicatorLayers.ts` afterward, rather than two
independent horizontal-line draws competing for the same canvas region.

## 5. Configuration UI

Two places it could live; recommend the panel, not the chart, for a first version:

**Recommended: `ui/PriceAlerts.tsx`**, structured like `ui/Watchlist.tsx` for the list
(row-per-alert, symbol + direction + price + a remove `✕` mirroring `Watchlist.tsx:132-144`, plus
an `active` toggle) and like `ui/Positions.tsx`'s inline add/edit form (the `adding`/`editing`
state pattern at `Positions.tsx:54-58`, using `SymbolSearch` — already imported there,
`Positions.tsx:18` — to pick the symbol, prefilled with the chart's current `symbol` from
`InvestingPage.tsx:70`). Mount it as its own `Panel`, most naturally beside or under the
`positions-panel` (`InvestingPage.tsx:359-400`), following the same "sibling panel across the full
page width" reasoning already documented at `InvestingPage.tsx:304-309`. Use `formatAmount` from
`@/shared/lib/money` for the threshold price, matching how `Watchlist.tsx:4` and `Positions.tsx:12`
already format prices.

**Deferred: in-chart placement** (click the price axis, or drag a line, to set a threshold) is a
nicer interaction but a much bigger one — `CandleChart.tsx`'s pointer handlers
(`CandleChart.tsx:193-340`) already juggle pan/drag/crosshair state, and it's the same surface
worker2 is mid-edit on. Not worth attempting in the same change that also adds chart drawing; a
good v2 once the panel version has proven the data model and evaluator.

## 6. Toast + sound

**No toast mechanism exists in the app today.** A repo-wide `grep -rli toast apps/web/src` returns
nothing, and `apps/web/src/shared/ui/` only has `Panel`, `Button`, `PageHeader`, `SaveStatus`,
`Stat` — no notification primitive. This needs new shared infrastructure, not a reuse.

Proposed: `shared/ui/Toast.tsx` — a `<ToastHost />` mounted once (near the app root, or at minimum
inside `InvestingPage` given the stated scope) plus a module-level bus, the same "hook or component
subscribes, anything can push" shape `data/quoteBus.ts` already uses for a singleton
(`export const quoteBus = new QuoteBus()`, `quoteBus.ts:221`). Concretely: a `toastBus` object with
`push(toast)` / `subscribe(listener)`, and `ToastHost` reading it via `useSyncExternalStore` (or
`useEffect` + `useState`). This lets the alert evaluator (`useAlertEvaluator`, §3) call
`toastBus.push(...)` directly without needing to be inside the same component tree as the host.

**Sound and autoplay.** Browsers block `.play()` calls that aren't the direct result of a user
gesture; a price crossing is a background event with no accompanying click, so this is a real
risk, not a theoretical one. Standard mitigation: create one `AudioContext` (or one reused
`<audio>` element) lazily, and arm it on the page's first user interaction — a one-time capturing
`pointerdown`/`keydown` listener at mount that calls `.resume()` (or a muted `.play()`/`.pause()`
warm-up for a plain `<audio>` element) and then removes itself. By the time any alert can
realistically fire, the user has already interacted with the page (loading a symbol, scrolling the
watchlist), so this is a one-line tripwire, not a UX gate. If the context is still unarmed when an
alert fires (tab opened and never touched), skip the sound and still show the toast — never let
audio failure block or throw past the notification.

Reuse a single audio element/buffer across firings rather than constructing a new `Audio()` per
alert, so several alerts firing in the same batch don't stack overlapping playback. A mute
preference is cheap to add later (`STORAGE_KEYS` already has `'prefs'`, `keys.ts:3`) but is scope
creep for a first version — flagging, not proposing for step 1.

## 7. Risks, edge cases, tests

- **Market closed.** The sweep still runs, just slowly (`session.ts:162`, 900s in the `closed`
  regime), and the SSE stream carries no ticks for a symbol that isn't trading (`data/quoteStream.ts:12-15`
  says a tick is a trade). So alerts still evaluate off the slow sweep and can fire up to ~15
  minutes late outside market hours — expected, not a bug, but worth a toast wording that says
  "at last quote" rather than implying a live price.
- **Symbol with no quote yet.** `bySymbol.get(symbol)` is `undefined` until the sweep answers;
  skip evaluation for that alert this tick, the same null-guard `valuePosition` already uses
  (`portfolio.ts:149`, `if (!quote || !Number.isFinite(quote.price)) return null`).
- **Page reload.** `previousSide` is in-memory only (§3) and is lost on reload. Per `crossed()`
  above, the first observed price after (re)hydration only **seeds** `previousSide` — it never
  fires. This is a deliberate choice: firing retroactively for a threshold that was crossed while
  the tab was closed would be surprising (which crossing, how long ago?) and contradicts the
  already-made "no backend watcher" decision — "the tab has to be open" is the accepted tradeoff of
  that decision, not a gap to patch around.
- **Several alerts on one symbol.** This is exactly why the data model is id-keyed (§1); the
  evaluator must track `previousSide` per alert id, not per symbol, so an "above 220" and a
  "below 190" alert on the same symbol are fully independent and can both be armed and can both
  fire.
- **Coalesced ticks.** `useQuoteStream` collapses several ticks arriving within one animation frame
  to the latest price per symbol before it ever reaches a render (`useQuoteStream.ts:95-116`), so
  the evaluator only ever sees one price per symbol per render — it cannot observe an intra-frame
  crossing that both crossed and crossed back before the frame flushed. Accept this; it's the same
  limitation the rest of the price pipeline already has (the watchlist flash, the tape, the chart
  readout all work off the same coalesced value).
- **Alert on a symbol not otherwise followed.** `InvestingPage.tsx:106-109` builds `wanted` (what
  gets a quote at all) from `symbol` + `watchlist.symbols` + `holdings.symbols`. An alert on a
  fourth symbol — followed by neither the watchlist nor the portfolio — would never receive a
  quote and so never evaluate. **This needs a wiring change**: extend the `Set` at
  `InvestingPage.tsx:107` to also include alert symbols, or the feature silently doesn't work for
  that case. Not optional — flagging it now so it isn't missed during implementation.

**Tests needed:**
- `data/priceAlerts.test.ts` — normalize/add/update/remove/toggle, mirroring `portfolio.test.ts`
  and `watchlist.test.ts` (bad-shape input, duplicate ids, boundary values for `price`).
- `lib/alertCross.test.ts` — feed `crossed()` a sequence of prices and assert which fire, mirroring
  `latch.test.ts`'s style: explicit sequences, including "first observation never fires" and
  "repeat re-arms only after crossing back, not on every subsequent tick past threshold."
- A scale-mapping test for whatever price→y line helper lands in `indicatorLayers.ts`, mirroring
  `lib/scales.test.ts`.
- A toast bus test (`push`/`subscribe`, no DOM required).

## 8. Implementation plan

1. **Data model + persistence** (S) — `data/priceAlerts.ts` + `hooks/usePriceAlerts.ts` on the
   already-reserved `'alert-rules'` key. Tests mirroring `portfolio.test.ts`.
2. **Pure cross-detection** (S) — `lib/alertCross.ts` + `lib/alertCross.test.ts`, no React.
3. **Wire evaluation into the page** (M) — extend `InvestingPage.tsx`'s `wanted` to include alert
   symbols; add `hooks/useAlertEvaluator.ts` (ref-held `previousSide` map, effect keyed on
   `bySymbol`); for this step, just collect fired alerts (stub the notification) to prove the path
   end to end before adding UI.
4. **Toast primitive** (S) — `shared/ui/Toast.tsx` + `toastBus`, wired to step 3's fired-alert
   callback.
5. **Sound** (S) — first-gesture-armed audio, played alongside the toast; mute is optional, defer.
6. **Configuration panel** (M) — `ui/PriceAlerts.tsx`, list + add/edit/remove/toggle, mounted in
   `InvestingPage.tsx` near `positions-panel`.
7. **Chart line** (M, sequence after/with worker2) — `alerts` prop on `CandleChart`, `drawAlertLines`
   in `indicatorLayers.ts`. Coordinate with whatever lands from the position-line work rather than
   editing `drawChart` in parallel; consider merging both into one `drawPriceLines` helper.
8. **Polish** (S) — mute preference, "at last quote" wording when market is closed, empty/error
   states matching the pattern at `InvestingPage.tsx:331-334`.

Steps 1–5 have no dependency on the chart and can ship (evaluator + toast + sound, no visual line
yet) before step 7 is even unblocked by worker2's change landing.
