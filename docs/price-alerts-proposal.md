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

**Extended-hours quotes are skipped entirely, not merely excluded from firing.** `PriceAlertsWatcher`
checks `quote.extended` (the same flag `data/quoteStream.ts` computes server-side and the chart's
own `isGhost`/`extended` badge already read — see `lib/session.ts`) and, when true, never calls
`evaluateAlert` at all for that tick — the tracked side stays whatever the last _regular_-session
price left it at. That is what makes a crossing that happens pre-market wait for the open: the
first regular print after it is evaluated against the last known regular state, not against the
extended one.

**State lives in a `useRef<Map<alertId, TrackedAlert>>` inside `PriceAlertsWatcher`** — never
persisted. A reload loses it; the first price observed after reload only seeds (§ above), so a
reload can never cause a stale or duplicate fire. This is the accepted cost of "no backend
watcher," not a gap to close.

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

**The UI refuses an alert whose target the current price already meets** (`lib/alertCross.ts`'s
`canCreateAlert`): creating "buy NVDA at 200" while NVDA is already at 190 is rejected with an
inline error rather than accepted-and-silent, because — via the same reseed rule from §3 — it
would otherwise either never fire (nothing to cross from) or need a special-cased immediate fire,
neither of which is what "tell me when it gets there" means. Absent a quote for the symbol, there
is nothing to judge it against, so it is allowed — this reuses the same reasoning
`valuePosition` uses for a position with no quote yet. The same check runs on edit, not only on
create, for the same reason.

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

- **Market closed / extended hours.** Superseded by §3's stricter rule: an extended print is never
  evaluated at all (not merely never fired on), so a crossing there always waits for the next
  regular-session quote. Outside all sessions, the sweep still runs on the slow `closed`-regime
  cadence from `lib/session.ts`.
- **Symbol with no quote yet.** Skipped for that tick, the same null-guard `valuePosition` uses.
- **Page reload.** Unchanged from the draft: the tracked side is never persisted, and the first
  post-reload observation only seeds — never fires retroactively.
- **Editing an armed alert.** New in this revision (§3, §5): re-seeds instead of firing spuriously
  or going permanently mute. Covered by explicit tests in `lib/alertCross.test.ts`.
- **Several alerts on one symbol.** Tracked per alert id in the watcher's map, fully independent.
- **A newly created alert whose target is already met.** Refused by the UI (§5) rather than
  silently accepted into a state it can never fire from.
- **Exact-price ties.** Explicitly count as met for both kinds (§3), not left to `>=`'s default
  behaviour without comment.
- **Leaving the Investing page.** No longer a risk at all, because the evaluator does not live
  there — this was the point of moving it above the router (§3).

**Tests shipped:**

- `data/priceAlerts.test.ts` — normalize, add, update (including "leaves `active`/`triggeredAt`
  untouched"), remove, setActive, markTriggered, `alertsFor`/`activeAlertSymbols`.
- `lib/alertCross.test.ts` — `sideOf`'s exact-tie behaviour, `evaluateAlert`'s seed/fire/re-arm
  cycle, the edit-reseeds cases, and `canCreateAlert`.
- `lib/alertSound.test.ts` — arm/mute/play with an injected fake `AudioContext`, and that nothing
  throws with no `AudioContext` at all.
- `shared/ui/toastBus.test.ts` and `ToastHost.test.tsx` — stacking, independent per-toast timers,
  manual dismiss.
- `hooks/usePriceAlerts.test.tsx` — hydration and persistence of add/update/toggle/trigger, mirroring
  `usePortfolio.test.tsx`.
- `PriceAlertsWatcher.test.tsx` — a genuine crossing firing a toast, a tone, and persisting the
  trigger; an extended-hours print being ignored until the next regular one.
- `chart/priceLines.test.ts` — the new `dash` override and `alertPriceLine`.
- `chart/CandleChart.test.tsx` — the alert lines' `aria-label` text, alone and alongside a position
  line.
- `ui/PriceAlerts.test.tsx` — row rendering, toggle/remove/edit, and the create-time rejection.

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
