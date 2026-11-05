# SEACE PDF preview latency (2026-11-05)

The preview fetches a public SEACE PDF through the gated API and then creates a
blob URL for the iframe. This branch reuses the API's `httpx.AsyncClient` and
starts at most one speculative fetch after a document link has been hovered or
focused for 250 ms. Speculative fetch starts are spaced at least one second
apart within a page. The completed blob is kept for 30 seconds or until another
document is selected.

## Live upstream measurements

The sample was prod6 document `433954` (2,338,665 bytes). Measurements called
`preview_document` in a single Python event loop, including the entire upstream
download and PDF validation, but excluding browser rendering. Each request
finished before the next started, with an additional 1.1 second pause. Both
modes ran through the same route function; the baseline created a new HTTPX
client per call, while the optimized mode used the shared client. All seven
requests returned a valid PDF.

| Mode                   | Durations (ms)             | Median (ms) |
| ---------------------- | -------------------------- | ----------: |
| New client per request | 2,135; 2,135; 1,691        |       2,135 |
| Shared client          | 1,801; 1,345; 1,326; 1,333 |       1,339 |

The shared client's median was 796 ms (37%) lower in this small sequential
sample. The first shared request was cold; later requests benefited from the
existing connection. Upstream transfer time varies, so this is a measured
sample rather than a guaranteed saving for every PDF.

## Click after link intent

With the shared client, the same PDF was requested 250 ms after simulated link
intent. The click occurred one or two seconds after intent. The click awaited
the already running request, as the UI does.

| Intent-to-click | Full fetch | Additional wait after click |
| --------------- | ---------: | --------------------------: |
| 1 second        |   1,322 ms |                      563 ms |
| 2 seconds       |   1,679 ms |                        0 ms |

This measures network and backend work, not the iframe's paint time or real
user hover behavior. A click before the 250 ms debounce uses the normal request
path. The UI tests cover reuse of in-flight and completed requests, keyboard
focus, brief hovers, and the one-in-flight limit.
