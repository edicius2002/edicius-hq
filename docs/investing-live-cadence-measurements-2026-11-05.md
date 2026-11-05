# Investing live cadence measurements — 2026-11-05

## Method

The same `work/investing_live_cadence_measure.py` probe ran against the
unchanged parent checkout (500 ms publication, 5 s Yahoo pause) and this branch
(250 ms, 2 s). It fed a changed AAPL tick every 50 ms into the real
`MarketWorker._publish_ticks` loop and ran the real `CompositeBarStream` with a
fake, immediately returning Yahoo client. No Supabase or Yahoo calls are made by
this local probe. Each run lasted 12.5 s; an optional fake broadcast POST took
100 ms. Intervals use `time.monotonic()`; p95 is linearly interpolated.

| Simulated POST | Source   | Quote broadcasts | Quote interval p50 / p95 | Yahoo fetches | Yahoo interval p50 / p95 |
| -------------- | -------- | ---------------: | -----------------------: | ------------: | -----------------------: |
| 0 ms           | Baseline |               24 |         513.1 / 516.1 ms |             3 |       5001.6 / 5001.9 ms |
| 0 ms           | Branch   |               47 |         264.2 / 267.0 ms |             7 |       2008.5 / 2013.8 ms |
| 100 ms         | Baseline |               20 |         606.7 / 609.9 ms |             3 |       5006.1 / 5010.7 ms |
| 100 ms         | Branch   |               35 |         357.9 / 360.7 ms |             7 |       2008.8 / 2010.8 ms |

The scheduled pause starts after a broadcast POST finishes, so its latency adds
to the observed quote interval. A Yahoo fetch likewise adds to the focused
candle interval. These numbers measure Pi scheduling under controlled inputs,
not provider event frequency, Realtime delivery, browser paint, or mobile
network latency. One symbol with continuous price changes represents a busy
upper bound; a quiet symbol causes no quote broadcast.

## Real Pi provider sample

The existing read-only `work/investing_pi_provider_probe.py 1m` ran on host
`bodas` against the deployed AAPL Yahoo adapter during the US regular session.
Four sequential 1m chart reads returned 1,500 bars each in 0.391, 0.309, 0.315,
and 0.312 s (median 0.314 s). Its first 1d warmup took 0.625 s. This probe
uses the historical chart request, whereas the focused live candle fetch asks
for a shorter 1m range; the sample is provider context, not an exact addition
to the live candle measurements above.

The exact `YahooLiveBarClient.fetch` path was then sampled eight times, 2 s
apart, with `work/investing_pi_live_bar_probe.py`. Each call returned a bar;
only one of the seven follow-up calls changed its OHLCV. The provider's `as_of`
advanced by 10 s on that call and stayed unchanged on the others. Fetch
durations were 503 ms on the first call and 100–254 ms afterward. This is one
short AAPL sample: it shows that the 2 s interval can read duplicate provider
data, even though it can discover the next change sooner than a 5 s interval.

In a separate 20.1 s read-only Yahoo quote-stream sample on the same Pi,
`work/investing_pi_quote_stream_probe.py` received 20 frames and 17 distinct
prices. The median gap between distinct prices was 1,032 ms and the median
exchange timestamp age on arrival at the Pi was 1,802 ms. The 250 ms worker
cycle reduces batching delay but cannot remove that upstream timestamp age.

## Limits and rollout measurement

This branch was not deployed. The existing authenticated Chrome window could
not be inspected because automatic approval review rejected access to its
unrelated private tab. The Pi service journal also requires sudo credentials
not available to this session. Therefore no production browser receipt or
paint latency, and no actual mobile versus desktop distribution, is claimed.

After deployment, record provider tick arrival, worker broadcast start/end,
Realtime receipt, and visible price/last-candle update for a moving symbol on
desktop and mobile. Compare p50/p95 and missed updates over at least five
minutes during regular trading, and check Yahoo errors and Supabase Realtime
traffic before keeping the faster cadence.

## Verification

- Targeted worker and bar-stream tests: 49 passed.
- Web suite: 2,757 passed, 2 skipped.
- API suite excluding SEACE: 1,382 passed, 28 skipped, 98 deselected.
- Changed Python files: Ruff check and format check passed; mypy passed for
  the two changed production modules.
- The complete API suite stopped in SEACE because the available global Python
  has `mcp==1.30.0`; `services/api/requirements.txt` requires `mcp==2.3.0`.
  The failing import was `mcp.server.mcpserver`, outside Investing.
