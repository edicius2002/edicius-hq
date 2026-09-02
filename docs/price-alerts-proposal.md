# Price alerts for Investing

Scope: `apps/web/src/features/investing/` (`chart/`, `data/`, `hooks/`, `lib/`, `ui/`), what it
uses of `apps/web/src/shared`, and the app shell (`apps/web/src/app/App.tsx`) for the one piece
that has to live above the router. Airfare, Finance and Dashboard are out of scope.

This started as a design-only proposal (commit `1e616fa`). It has since been implemented; this
revision records what actually shipped and why, where that differs from the original design. The
numbered decisions below were made by the user after reading the first draft and supersede it.

Already decided from the start: notification is a toast + a sound, no browser `Notification` API,
no backend price watcher. Alerts are visible on the chart.

## 1. Data model

```ts
// apps/web/src/features/investing/data/priceAlerts.ts
export type AlertKind = 'buy' | 'sell';

export type PriceAlert = {
  id: string; // crypto.randomUUID() — several alerts can watch one symbol at once
  symbol: string;
  kind: AlertKind;
  price: number;
  active: boolean;
  createdAt: number;
  triggeredAt: number | null;
};

export type AlertRules = { version: 1; alerts: PriceAlert[] };
```

**`kind: 'buy' | 'sell'`, not `direction: 'above' | 'below'`.** The UI speaks in the user's own
terms — "buy NVDA at 200" — and the crossing direction is derived from that, not stored
separately: `buy` fires when the price falls to or below `price`, `sell` when it rises to or above
it. See `lib/alertCross.ts`'s `sideOf`.

**No `repeat` field.** An alert is one-shot only in this version. It fires once, then deactivates
— see `markTriggered` below — and can be manually reactivated, but does not re-arm itself.

**`id`, unlike `Position`/`WatchlistEntry`.** Several alerts can watch the same symbol (a buy
floor and a sell ceiling on one ticker), so the row's identity has to be its own id rather than
the symbol.

**A fired alert stays in the list.** `markTriggered(rules, id, at)` sets `active: false` and
`triggeredAt: at` — it does not remove the row. The timestamp is shown in `ui/PriceAlerts.tsx`
("Fired 02 Sep, 14:32") and the row's toggle reactivates it from there.

## 2. Persistence

`data/priceAlerts.ts` + `hooks/usePriceAlerts.ts`, structured exactly like `data/portfolio.ts` +
`hooks/usePortfolio.ts`: pure transition functions (`addAlert`, `updateAlert`, `removeAlert`,
`setActive`, `markTriggered`, `alertsFor`, `activeAlertSymbols`) plus a thin hook wrapping
`useStoredDocument` on the already-reserved `'alert-rules'` key (`shared/storage/keys.ts:5`) — no
change to `keys.ts` was needed. `usePriceAlerts` generates `id`/`createdAt` at the hook layer
(`crypto.randomUUID()`, `Date.now()`), the same way `useFinanceData.ts`'s `newId()` does, and
passes a fully-formed `PriceAlert` down to the pure `addAlert`.

`activeAlertSymbols(rules)` — every symbol carrying at least one active alert, deduplicated — is
what the global evaluator (§3) subscribes to. It deliberately does not depend on any page's
watchlist or portfolio.

## 3. Detecting a crossing — and evaluating it globally, not per-page

**Where this evaluates now: above the router, not inside `InvestingPage`.** The original design
tied the evaluator to `InvestingPage`'s `bySymbol` map and flagged, as a risk, that its `wanted`
set would need to include alert symbols. The user overruled the whole placement: alerts must be
evaluated whether or not Investing is the current page, so leaving the page cannot lose the
tracked crossing state or go silent. `PriceAlertsWatcher.tsx` is mounted once in `App.tsx`,
alongside `<RouterProvider>` rather than inside it, and owns its own quote polling — a `useQuery`
against `quoteBus.quotes(activeAlertSymbols(rules), ...)` (the same module-level singleton
`InvestingPage`'s own quote query already uses, so a symbol that is both alerted-on and displayed
shares one cached/in-flight request). This is also what resolves the "symbol not otherwise
followed" risk the original design flagged: the watcher's symbol set is exactly the active alert
symbols, full stop — it was never `InvestingPage.tsx`'s `wanted` to begin with.

**`lib/alertCross.ts` — still not `lib/latch.ts` reused, same reasoning as before.** `latch.ts`'s
grace-period hysteresis is for connection liveness, not for a crossing that has to fire on the
tick it happens. What `alertCross.ts` copies is the shape: a pure, explicitly-transitioned state
value, tested without React or a market.

```ts
export type AlertSide = 'met' | 'unmet';

// A price exactly on the threshold counts as met, for both kinds — written this way
// on purpose, not hidden inside a bare `>=`.
export function sideOf(kind: AlertKind, price: number, threshold: number): AlertSide {
  return kind === 'buy'
    ? price <= threshold
      ? 'met'
      : 'unmet'
    : price >= threshold
      ? 'met'
      : 'unmet';
}

export type TrackedAlert = { price: number; kind: AlertKind; side: AlertSide };

export function evaluateAlert(
  alert: Pick<PriceAlert, 'kind' | 'price'>,
  price: number,
  previous: TrackedAlert | null,
): { fired: boolean; next: TrackedAlert } {
  const side = sideOf(alert.kind, price, alert.price);
  const reseed =
    previous === null || previous.price !== alert.price || previous.kind !== alert.kind;
  if (reseed) return { fired: false, next: { price: alert.price, kind: alert.kind, side } };
  return {
    fired: previous.side === 'unmet' && side === 'met',
    next: { price: alert.price, kind: alert.kind, side },
  };
}
```

**Editing an armed alert re-seeds it — this was a gap in the original design, now closed.** The
first draft only handled "the very first price ever observed never fires." It missed that editing
a live alert's `price` or `kind` leaves old tracked state describing a target that no longer
exists. `evaluateAlert` treats "first observation" and "the alert's own price/kind changed since
last time" identically: both re-seed (record the side, never fire) rather than comparing against a
stale threshold. Without this, editing a threshold would either leave the alert mute forever or
fire it on the spot for a crossing it never actually made. `lib/alertCross.test.ts` covers this
explicitly, including "re-seeded, then fires normally on the next genuine crossing."

**Exact-price ties count as met, for both kinds** — a buy at 250 fires on a tick that lands exactly
on 250, not only strictly under it. Written as an explicit `<=`/`>=` with a comment, not left
implicit.

**Non-regular quotes are skipped entirely, not merely excluded from firing — and the gate is
`marketState`, not `extended`.** The first cut of this used `quote.extended`, which only ever means
"pre- or post-market"; it says nothing about a fully closed market (a stale last read handed back
overnight or on a weekend), which needs to be excluded from evaluation exactly the same way. The
gate is `lib/alertCross.ts`'s `isRegularSessionQuote(quote)`, `quote.marketState === 'REGULAR'`,
checked for every state at once. When it is false, `evaluateAlert` is never called for that tick —
the tracked side stays whatever the last _regular_-session price left it at, which is what makes a
crossing that happens pre-market, post-market, or overnight wait for the open instead of firing on
a thin print.

**A never-tracked alert seeds from `previousClose`, not from whatever quote arrives first.** This
closed a real gap the first cut had: without it, an alert created while the market is closed seeds
its tracked side from the very first quote it ever evaluates — which, once non-regular prints are
skipped, is the opening regular print itself. Seeding _from_ that print rather than _against_ it
means a crossing that genuinely happened overnight — last night's close on one side of the
threshold, this morning's open on the other — is never detected: the opening print just becomes the
new baseline, silently. `lib/alertCross.ts`'s `seedFromPreviousClose(alert, quote.previousClose)`
fixes this by using `previousClose` — a field every quote already carries, no extra request needed
— as the seed the very first time an alert is evaluated. In `PriceAlertsWatcher`:

```ts
const previous = tracked.current.get(alert.id) ?? seedFromPreviousClose(alert, quote.previousClose);
if (!isRegularSessionQuote(quote)) {
  if (previous) tracked.current.set(alert.id, previous);
  continue;
}
const { fired, next } = evaluateAlert(alert, quote.price, previous);
```

The seed lands even on a non-regular print (a closed-market read still carries a valid
`previousClose`), so by the time the first regular quote arrives there is already an honest
baseline to evaluate it against — and if that baseline and the opening price sit on opposite sides
of the threshold, it fires right then, on the open. Returns `null` when there is no previous close
(a data gap, a brand-new listing), which falls back to the ordinary first-observation behaviour.

**State lives in a `useRef<Map<alertId, TrackedAlert>>` inside `PriceAlertsWatcher`** — never
persisted. A reload loses it; the first price observed after reload only seeds from `previousClose`
as above rather than firing outright, so a reload can never cause a duplicate fire — but it does
mean a reload picks up the same overnight-crossing detection a fresh creation gets, which is the
intended behaviour, not an accident.

## 4. Drawing the alert line on the chart

**The shared helper predicted in the first draft has since landed on `main`** (`#145`,
`chart/priceLines.ts`): `drawPriceLines(ctx, { lines: PriceLine[], band, plot, scale })` with
`PriceLine = { price, label, color }`, already used by the position entry line
(`positionPriceLine`). Implementing this feature meant extending that file, not adding a second
drawing path — the whole reason it was built general rather than position-specific.

`priceLines.ts` gained one field, `dash?: [number, number]` on `PriceLine` (defaulting to the
existing `[6, 4]` when absent, so the position line's own tests are unaffected), and one new
function:

```ts
const ALERT_DASH: [number, number] = [2, 2];

export function alertPriceLine(alert: Pick<PriceAlert, 'kind' | 'price'>): PriceLine {
  return {
    price: alert.price,
    label: `${alert.kind === 'buy' ? 'Buy' : 'Sell'} ${alert.price.toFixed(2)}`,
    color: alert.kind === 'buy' ? UP : DOWN, // same #8dd36f/#f08d78 the position line uses
    dash: ALERT_DASH,
  };
}
```

**The colour collision with the position entry line is deliberate, not overlooked.** The position
line already uses green/red for "latest close above/below what was paid"; an alert line reuses the
same pair for "buy/sell target." The user chose this knowing the two would share a chart. What
keeps them legible together is the dash pattern (`[2, 2]`, denser than the position line's
`[6, 4]`) and the label (`"Buy 200.00"`/`"Sell 260.00"`) — colour alone is not what tells them
apart.

`CandleChart.tsx`'s `drawChart` now builds one combined `lines` array — the position line (if any)
followed by one `alertPriceLine` per active alert on the charted symbol — and passes it to
`drawPriceLines` in a single call, rather than two competing draws. `CandleChartProps` gained
`alerts?: PriceAlert[]`; `InvestingPage.tsx` passes only the _active_ alerts for the _charted_
symbol (`alertsFor(alerts.rules, symbol).filter(a => a.active)`), the same way `position` was
already resolved to just the one for `symbol` before being passed down.

**Accessibility follows the position line's own precedent.** `CandleChart.tsx` already speaks the
position entry through the chart surface's `aria-label` (`positionSummary`, since a screen reader
cannot see the dashed line). Each active alert gets the same treatment — `"Buy alert at 200.00."` /
`"Sell alert at 260.00."` — appended alongside it.

**Alert price outside the visible range:** unchanged from the original design — `drawPriceLines`
already skips any line whose scaled `y` falls outside the price band rather than clamping it, which
was the behaviour to reuse, not reinvent.

## 5. Configuration UI

`ui/PriceAlerts.tsx`, mounted as its own full-width `Panel` (`id="alerts-panel"`) below
`positions-panel` in `InvestingPage.tsx` — structured like `ui/Watchlist.tsx` for the row list
(symbol, kind, price, a status column, active toggle, remove) and like `ui/Positions.tsx`'s inline
`AlertForm` for add/edit, reusing `SymbolSearch` for the ticker field the same way `Positions.tsx`'s
own form does. The add form is prefilled with the chart's current symbol.

**Rejection is regular-session-only; outside it, creation is always allowed, with a warning.**
`lib/alertCross.ts`'s `canCreateAlert(kind, price, currentPrice, isRegularSession)` refuses
creating "buy NVDA at 200" while NVDA is already at 190 _only_ when that 190 is itself a regular
quote — via the same reseed rule from §3, a regular-session alert created already past its own
target would otherwise either never fire or need a special-cased immediate fire, neither of which
is "tell me when it gets there." Outside the regular session (market closed, or extended hours)
there is no live price to judge it against — only a stale read — so creation always proceeds
regardless of whether that stale read already meets the target: an alert set up at 2am has to exist
for the open to evaluate it against (§3's `seedFromPreviousClose` is exactly what makes that
evaluation correct), not be turned away because the only price on hand right then reads as met.
When it does read as met outside the regular session, the form shows a non-blocking hint —
_"AAPL already meets this target at its last known price (190.00). It will sound the next time it
crosses, not immediately."_ — computed live as the fields are filled in, before submission, so the
user knows what they are creating rather than being surprised by silence later. Absent a quote for
the symbol entirely, there is nothing to judge it against either way, so it is allowed with no
hint — the same reasoning `valuePosition` uses for a position with no quote yet. The same check
runs on edit, not only on create, for the same reason.

**Every reason saving does not happen is said in the form, and the Save button is never silently
disabled.** The first cut disabled Save until the form was locally valid, which meant an incomplete
or refused submission gave no feedback at all — indistinguishable from a button that simply did not
work. `AlertForm`'s `onSubmit` now checks, in order, that a symbol was chosen ("Choose a symbol
first."), that a usable price was entered ("Enter a price above zero."), and only then the
regular-session rejection above — each with its own visible `role="alert"` message — and the button
stays enabled throughout. See §9 for how a save could go missing with no explanation at all before
this.

In-chart placement (click the axis to set a threshold) remains deferred, as in the original draft
— it is a bigger interaction, and the same chart surface that already had to be coordinated with
the position-line work.

## 6. Toast + sound

**`shared/ui/toastBus.ts` + `shared/ui/ToastHost.tsx`**, matching the original design's shape: a
module-level singleton (`push`/`subscribe`/`dismiss`), the same pattern `quoteBus` already uses,
and a `<ToastHost />` mounted once in `App.tsx`. Two things were pinned down that the draft left
open:

- **Each toast fades on its own after 5 seconds**, and several firing together stack rather than
  replace one another — `ToastHost` schedules one `setTimeout` per toast id the first time it sees
  it (tracked in a ref), not one effect over the whole list, which would have restarted every
  remaining toast's countdown whenever an unrelated one was added.
- Dismissing is also available by hand (an `✕` on each toast), in addition to the timeout.

**Sound: two distinct tones, and a mute control from the first version — not deferred.**
`lib/alertSound.ts` plays 880 Hz for a buy and 440 Hz for a sell through a `GainNode` envelope, and
exposes `setMuted`/`muted` on the player; a toggle button lives in the alerts panel header
("Sound on"/"Sound off"). The autoplay mitigation is exactly what the original draft proposed: one
`AudioContext`, created lazily, resumed on the page's first `pointerdown`/`keydown` (captured at
the window, detaching itself after firing once — `armOnFirstGesture`), and every failure mode
(`AudioContext` missing, still suspended, or throwing mid-play) degrades to a silent no-op rather
than touching the toast.

## 7. Risks, edge cases, tests

- **Market closed / extended hours.** A non-regular print is never evaluated at all (not merely
  never fired on), so a crossing there always waits for the next regular-session quote — and
  because a never-tracked alert seeds from `previousClose` rather than from that first print (§3),
  a crossing that happened overnight or over a weekend still fires the moment the regular session's
  first quote lands, instead of being swallowed as a silent new baseline.
- **Symbol with no quote yet.** Skipped for that tick, the same null-guard `valuePosition` uses.
- **Page reload.** The tracked side is never persisted; the first post-reload observation re-seeds
  from `previousClose` the same way a fresh creation does, so a genuine crossing that happened while
  the tab was closed still fires at the next regular quote rather than being silently missed.
- **Editing an armed alert.** Re-seeds instead of firing spuriously or going permanently mute.
  Covered by explicit tests in `lib/alertCross.test.ts`.
- **Several alerts on one symbol.** Tracked per alert id in the watcher's map, fully independent.
- **A newly created alert whose target is already met.** Refused by the UI only when the price it
  is judged against is itself a regular-session one; outside the regular session the alert is
  created regardless, with a visible hint saying so (§5) — never silently accepted into a state
  with no explanation, and never turned away just because the market happens to be closed.
- **Exact-price ties.** Explicitly count as met for both kinds (§3), not left to `>=`'s default
  behaviour without comment.
- **Leaving the Investing page.** No longer a risk at all, because the evaluator does not live
  there — this was the point of moving it above the router (§3).
- **A picked symbol vanishing from its own field, and a save that does nothing with no
  explanation.** Both were real bugs found in browser testing, not merely risks — see §9.

**Tests shipped:**

- `data/priceAlerts.test.ts` — normalize, add, update (including "leaves `active`/`triggeredAt`
  untouched"), remove, setActive, markTriggered, `alertsFor`/`activeAlertSymbols`.
- `lib/alertCross.test.ts` — `sideOf`'s exact-tie behaviour, `evaluateAlert`'s seed/fire/re-arm
  cycle, the edit-reseeds cases, `canCreateAlert`'s session-awareness, `isRegularSessionQuote`, and
  `seedFromPreviousClose` (including a full overnight-crossing scenario run through `evaluateAlert`).
- `lib/alertSound.test.ts` — arm/mute/play with an injected fake `AudioContext`, and that nothing
  throws with no `AudioContext` at all.
- `shared/ui/toastBus.test.ts` and `ToastHost.test.tsx` — stacking, independent per-toast timers,
  manual dismiss.
- `hooks/usePriceAlerts.test.tsx` — hydration and persistence of add/update/toggle/trigger, mirroring
  `usePortfolio.test.tsx`.
- `PriceAlertsWatcher.test.tsx` — a genuine crossing firing a toast, a tone, and persisting the
  trigger; a pre-market print being ignored until the next regular one; an alert created while the
  market is closed firing on the first regular reading when its target crossed overnight, and not
  firing when it did not.
- `chart/priceLines.test.ts` — the new `dash` override and `alertPriceLine`.
- `chart/CandleChart.test.tsx` — the alert lines' `aria-label` text, alone and alongside a position
  line.
- `ui/PriceAlerts.test.tsx` — row rendering, toggle/remove/edit, the create-time rejection (and its
  regular-session-only scope), the non-blocking already-met hint, and each of the three explained
  refusals (no symbol, no price, already met).
- `ui/SymbolSearch.test.tsx` (new) — a picked symbol stays in the field, the results list closes on
  pick and reopens on further edits, and a typed-and-entered symbol (via Enter) is kept the same way.
- `ui/Positions.test.tsx` — one line added confirming the picked symbol stays in `PositionForm`'s
  own search field too, now that the fix lives in the shared component both forms use.

## 8. What shipped, in order

1. **Data model + persistence** — `data/priceAlerts.ts`, `hooks/usePriceAlerts.ts`.
2. **Pure cross-detection** — `lib/alertCross.ts`, including the reseed-on-edit rule.
3. **Global evaluator** — `PriceAlertsWatcher.tsx`, mounted in `App.tsx` above the router, polling
   `quoteBus` directly for `activeAlertSymbols`.
4. **Toast primitive** — `shared/ui/toastBus.ts` + `ToastHost.tsx`, per-toast timers, mounted
   alongside the evaluator in `App.tsx`.
5. **Sound** — `lib/alertSound.ts`, two tones, mute wired into the alerts panel from the start.
6. **Configuration panel** — `ui/PriceAlerts.tsx`, mounted as `alerts-panel` in `InvestingPage.tsx`.
7. **Chart line** — extended the already-landed `chart/priceLines.ts` (`dash`, `alertPriceLine`)
   and `CandleChart.tsx` (`alerts` prop, combined `lines` array, `aria-label`), rather than adding
   a second drawing path.
8. Gates run clean: `format:check`, `lint`, `typecheck`, `test`.

## 9. Three fixes from browser testing

The user exercised the shipped feature against local KV data and found three problems, none of
which the test suite above had caught — all fixed in the same pass.

**1. The picked symbol vanished from `SymbolSearch`'s own field.** `SymbolSearch.tsx`'s `pick()`
cleared `query` back to `''` after a pick, leaving only a caller-drawn "Selected: X" line to say
what had been chosen — both `ui/PriceAlerts.tsx` and `ui/Positions.tsx` carry that same line, a
literal copy of each other. Fixed in the shared component, not locally to either form, since
nothing about `Positions.tsx`'s own use of it needed the clearing behaviour: `pick()` now sets
`query` to the chosen symbol instead of `''`, and a `pickedRef` records that so the results-list
effect can tell "the field holds what was just picked" apart from "the field holds something being
typed" — the first skips re-searching and keeps the list closed, the second (set in `onChange`,
cleared on any edit) searches normally. Both forms' "Selected: X" line is left in place; it is
mildly redundant now but not wrong, and removing it was not asked for.

While fixing this, a second, independent bug turned up in the same file: pressing Enter to confirm
a typed symbol had no `preventDefault()`, so — because both callers nest `SymbolSearch` inside their
own `<form>` — the same keystroke also triggered the browser's native submit-on-Enter behaviour,
submitting the surrounding form the instant a symbol was confirmed, before the rest of it (the
price, in `AlertForm`) had been filled in. This is likely the single biggest contributor to problem
2 below: it is a completely silent, easy-to-hit gesture (pick a symbol, the most natural next
keystroke is Enter) that used to submit against an empty price with the old disabled-button build
giving no feedback at all. Fixed alongside the retained-value change, in the same handler.

**2. Saving did nothing, with no visible reason.** Two contributing causes, not one — the user's
hypothesis (a) (an empty symbol from problem 1) turned out to be secondary to the Enter-key form
submission just described, and hypothesis (b) (the closed-market rejection) was real but was never
the _only_ failure mode. The actual fix was structural rather than chasing one root cause:
`AlertForm`'s Save button is no longer ever disabled, and `onSubmit` now checks, in order — no
symbol chosen, no usable price entered, then the regular-session-only rejection (§5, §9.3) — each
with its own `role="alert"` message. A save that silently does nothing is worse than one that
refuses and says why; making every refusal visible closes off this whole class of bug rather than
only the two specific paths that were reported.

**3. Creating an alert with the market closed.** This revises decision 8 from the original design,
which rejected any alert whose target the current price already met, unconditionally. The user's
refinement: creation must always be possible, including with the market closed or in extended
hours — what "will not fire until the open" is supposed to mean is that a crossing that already
happened is still honoured at the next regular quote, not that it is discarded. Three parts, covered
in §3 and §5 above and worth restating together here since they were delivered as one fix:

- `canCreateAlert` only rejects when the price being judged is itself from the regular session
  (`isRegularSessionQuote`); outside it, creation always proceeds.
- When the last known price already meets the target outside the regular session, the form shows a
  non-blocking, live-updating hint instead of a rejection, so the user knows what they are creating.
- `seedFromPreviousClose` is what makes "will sound at the open" true rather than aspirational: a
  never-tracked alert's baseline is the last regular close, not the first print it happens to
  observe, so a crossing that occurred between that close and the next regular quote — most often
  overnight — fires the moment that quote lands, instead of being silently absorbed as a fresh,
  unseeded starting point.
