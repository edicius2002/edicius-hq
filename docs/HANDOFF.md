# Handoff — Airfare, 2026-08-20

Written at the end of a long session. Everything below is either a decision
nobody has made yet, or something that cost time to learn and is written down
nowhere else. What _happened_ is in the PR bodies and the decision log; this is
what they do not say.

## Where things stand

`main` is at `3378883`. Zero open PRs, zero open issues, only `main` on the
remote. Eight PRs landed today (#89 through #96 plus #86, #87, #88), covering the
booking-horizon curve, the two analysis charts, the flight table, the watched
routes form, the itinerary parser and a manual refresh that runs on the server.

The archive is young, and that governs what can be tested. Two routes are
watched, one collection day for most of it. Neither stored curve has a single
hole in it, so **most gap-handling behaviour on the charts is proved against
fixtures, not against real data** — several PRs say so explicitly and it is worth
believing them.

## Decisions nobody has made

Ranked by consequence.

**Nothing is scheduled.** The collector has only ever run by hand. Every piece of
machinery built for it — the cadence table, heartbeats, fingerprints, the request
budget, the one-press refresh — exists to accumulate a price history that is not
accumulating. This was the premise of the whole feature: no source sells a deep
fare history, so it has to be built one day at a time starting now. It is not
being built.

**The daily budget is enforced now** — `a-day-is-what-the-budget-bounds`, S.39.
It was spent as a _per-pass_ ceiling with nothing carrying across passes, so the
day's total was unbounded and turning on a schedule without closing it was the
only thing on this list that could affect someone outside this machine. Spend now
accumulates in `.local-data/fares/spend/<day>.jsonl`, one line per request
actually sent, and the horizon pass spends from the same ceiling instead of being
uncounted. The default rose from 300 to 600, because the watchlist costs 442 a
day and the busiest day this address has ever had was 329.

**And two passes can no longer both plan a day** — `one-pass-at-a-time-is-a-file`,
S.40. The ledger alone made the day's total right only in arrears: every pass
re-reads it before every request, but two starting together each read a day with
600 left and each size a whole day of work before either has written a line. The
runner's single slot could not help, because it is one object in one process and
a scheduled command is a second one. A pass now takes a lock file before it plans
and gives it back when it is done; the second to arrive sends nothing and reports
every departure as `another-pass-is-running`, which is not a failure and does not
exit non-zero. A killed pass's lock is cleared by the next pass after five minutes
of nobody touching it. There are two locks, one per slot, so a board pass and a
calendar pass still overlap exactly as `calendar_job` decided they should — the
shared-queue question that module leaves open is still open. The ledger also
stops growing forever: a day file is kept ninety days.

What is still open is the item above: **nothing is scheduled yet**, and creating
the task is a decision for the owner rather than something an agent should do on
their machine. Everything that was standing in the way of it is now closed.

**Whether a manual press may override the cadence.** Recorded as open in 12.212.
The recommendation from the measurement work: keep the cadence as the default and
add a separately-named force. A press is now cheap to start and returns instantly,
which makes it _easier_ to press and so more dangerous — one press is roughly a
tenth of the day's budget, and since S.39 that budget is one the day is actually
keeping, so a press spends against the scheduled passes rather than beside them.

**The table and the chart use different clocks.** The flight table groups rows by
_observation_ date; the chart above it plots _departure_ date. On screen the
heading says `Flights seen · 09/03/2027` while the caption inches below says
`10 flights seen on 20/08/2026`. Both true, both about different things, and
sitting together they read as a contradiction. Which clock should govern the
table is a product decision, deliberately left alone by every agent who touched
it.

**The price plate is absent across most of chart 1.** Answered, and it was not
the reading anyone wanted: the plate falls back to the provider's baseline where
we have no median of our own, and says which of the two it is showing
(`the-plate-falls-back-to-the-provider`, `a-plate-wears-the-line-it-reads`). It
still never reads the pointer's height, and a period neither series reached still
draws nothing.

**`AnalysisPanel.module.css`'s height comment does arithmetic that does not
hold.** Found while fixing the pointer conversion
(`the-pointer-is-in-the-drawing-not-the-box`) and **deliberately left alone**,
because correcting it moves the panel's height and that is a different change
with its own before and after. Two things are wrong with
`clamp(28rem, calc(44.5cqw + 170px), 34.5rem)`: the comment reasons in 16-px
rems while the app root is **20px**, so every rem figure in it is a quarter
short of what ships; and `170px` is chart B's chrome as it was measured then,
where the real figure at the owner's window on 2026-08-22 is **194px** — body
659.1px, svg box 465.44. The effect is that chart B is pillarboxed by 26.3px a
side rather than getting the whole plot the comment promises it, which is a
smaller plot and nothing worse. Whoever changes it should re-measure both
numbers and expect the panel to get taller.

**Chart A pillarboxes above about 1658px of chart width.** Measured on
2026-08-22 by driving the panel's own container query from 300px of stage to
1858: chart A's 760×284 letterboxes at every chart width from 373 to 1638 and
pillarboxes from about 1658 up, which is a stage of roughly 1698px — an
ultrawide, or a 2560-px monitor at 100% scaling. Nothing breaks there any more,
since the conversion subtracts the bars either way, but the two charts do not
box the same way at every width and that boundary moves whenever `.body`'s
height does. It is the reason chart A took the same fix as chart B despite the
change being observably nothing on it today.

**Filters survive a route change.** `FlightTable` is not keyed by route, so
switching routes keeps a carrier filter that the new board may not contain — zero
rows, and a select showing a value its own options no longer offer. Pre-existing.

**Whether the provider's far horizon is a fixed date or a shrinking window.**
Recorded as open in 12.250. `MAX_DEPARTURE_HORIZON_DAYS = 330` was measured on
2026-08-19 and was wrong by the next morning. #95 made the collector stop
depending on it being exact — it walks a refused far end back and asks again — so
this no longer breaks anything, but the question is unanswered and only a second
day of measurement settles it.

## Running it on this machine

**Ports 8000 and 8001 are dead sockets.** Their processes no longer exist and
`taskkill` cannot free them; only a reboot does. `npm run api:dev` targets 8000
and will fail. Use another port.

A working pair:

```
cd services/api
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8003 --reload
cd apps/web && VITE_API_URL=http://localhost:8003 ../../node_modules/.bin/vite --port 5174 --strictPort --host 127.0.0.1
```

**Use `--reload`.** Without it uvicorn keeps the code it loaded at start no matter
how many branches move underneath, and the symptom is baffling: a working feature
answers as an older version of itself. That is exactly what broke a fetch today,
and the first hour of looking for it was spent in the wrong file.

`CORS_ORIGINS` defaults to `localhost:5173` only, but it reads an environment
variable, so widening it for one process is the polite way to run a second pair
without evicting anyone.

**Never point a test server at the real `.local-data`.** Copy it and set
`LOCAL_DATA_DIR`. An agent's browser verification overwrote the user's watchlist
today and it had to be reconstructed from an earlier reading.

## Traps that cost time

**A synthetic `WheelEvent` carries `offsetX`/`offsetY` as 0**, and the map's wheel
handler reads exactly those (`RouteMap.tsx`). Every scripted zoom therefore
anchors at the canvas corner and sails into empty ocean with no labels — which
looks precisely like a broken map. Four attempts were lost to this before the
cause was found. Override them with `Object.defineProperty` before dispatch, and
anchor on a known point so you can confirm it holds still.

**Browser tabs drift between servers on their own.** A verification once read the
heading off a different agent's server and a working feature was nearly reported
as broken. Assert `location.port` at the top of every browser query and throw if
it is not yours.

**`git checkout --` and `git restore` eat uncommitted work.** Four separate
incidents in one day, across three agents and the session itself. Commit before
touching git.

**Never dump large payloads into an agent's context.** The subdivision data files
run to 326 kB on one line; an agent died of out-of-memory reading one. Measure
with `curl -o /dev/null -w '%{size_download}'`, inspect with `jq` that prints
counts and keys, never values.

**React batches synchronous clicks.** Six clicks on a pager in one tick advance
one page. Put a real delay between them before concluding the pager is broken.

## Verify the decision log by content, not by count

This is the one that did real damage. The log's ids used to be a running
sequence, so parallel branches all read the same last number and took the same
next ones. Merging then left two rows claiming one id, something had to choose,
and the row it did not choose vanished — while the row count still added up and
no id appeared twice. Every check passed. Four decisions were lost that way in one
day and all four were found by comparing text against an earlier commit.

The convention has since changed: existing numbers are frozen as permanent names
and **new decisions are named after what they say** (`month-is-collected`,
`parse-drift-is-loud`). Two branches deciding different things cannot pick the
same words, so nothing is left for a merge to choose between.

Two habits are worth keeping anyway:

- **Renumber before merging, never during.** If two rows already differ, there is
  nothing to reconcile.
- **Merge rather than rebase** a branch with several commits. A rebase asks you to
  resolve the same table once per commit; one such rebase produced a table holding
  173 rows where 166 were expected, both the old and the renumbered copies.
