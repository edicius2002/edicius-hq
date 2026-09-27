# Navigation continuity review

Reviewed on 2026-09-27 against `fd7a4c7`, covering the six implemented application pages.

| Page       | Finding and outcome                                                                                                                                                                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Airfare    | A new server page removed the table, filters and pager. Selecting a watched month replaced the table through its React key. Chart navigation also rendered the unrelated globe. Retain successful responses within the same route, keep their month/period labels, preserve the table component, and reuse the globe element when its inputs have not changed. |
| Dashboard  | A failed background tweet refresh removed already loaded posts. Keep the posts and show a retry notice alongside them.                                                                                                                                                                                                                                         |
| Sentiment  | A failed background refresh removed all eight charts. Keep complete historical data and its chart elements, with a retry notice.                                                                                                                                                                                                                               |
| Investing  | The candle canvas remains mounted while switching timeframes; a loading overlay occupies its existing frame. Pan, zoom and candle-table visibility are local chart state. Existing history caching handles reopening a series. No changes made; bars from a different symbol or timeframe must not be presented as the selected series.                        |
| Greenlight | Chart interaction and projector month selection use local component state. Monthly/weekly summaries render in place; there is no server-paginated table. No matching replacement defect found in this review.                                                                                                                                                  |
| Finance    | The diagram owns its camera interaction. This page has no chart-month selector or server-paginated table. No matching replacement defect found in this review.                                                                                                                                                                                                 |

## Retention rules

- Pending and failed replacement reads keep the last successful response for the same route.
- Changing routes clears that fallback immediately. Confirmed empty responses replace old data.
- Retained rows keep the departure-month label and observation period they were fetched with.
- Month and granularity changes reset the requested table page. Filters and sorting survive a month change on the same route.
- Pagination is disabled during replacement reads, while filters stay mounted and editable. Superseded requests cannot replace the active query's results.
- A loading message occupies a reserved caption line, preserving the table's height while the existing rows remain visible.
- Departure-chart navigation remains independent of retained price-history data, including after failed reads.

## Validation

Regression tests reproduce the original DOM removal and unrelated map render, then verify table identity, filter focus, month labels, retries, superseded responses, navigation after a failed month read, and resource isolation. Dashboard and Sentiment tests verify that background errors preserve the existing content elements.

A local Chromium harness exercised the real `ProjectedFlightTable`, React Query, and styles with prepared responses delayed by 700 ms. At 1440 × 1000 and 390 × 844, pagination kept the same table and filter nodes, its document position and height remained unchanged during loading (0 px height difference), and month switching preserved the old label until the new rows arrived. No JavaScript errors occurred. Chromium ran headless with GPU acceleration disabled.

The browser harness used synthetic fares and excluded production authentication, live network latency and the complete application shell. It verifies continuity of the table layout, not production frame rate. The other pages were inspected in source; this is not a claim that every interaction across the application has been profiled or that all React renders should be eliminated.
