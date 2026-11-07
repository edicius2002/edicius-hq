# SEACE PDF preview load measurements

Date: November 7, 2026. Tests ran on `feat/seace-preview-prefetch-performance` without production code changes. The streaming prototype existed only during measurement. Requests to SEACE ran serially, with an additional 1.1-second pause between them.

## API: buffered response versus streaming

A local test app exposed two endpoints for the same public prod6 PDF (`433954`, 2,338,665 bytes). `buffer` called the current `preview_document`, which finishes reading from SEACE before responding. `stream` validated the `%PDF-` prefix and forwarded chunks as they arrived. Both used a shared HTTP client and `GZipMiddleware`. The client received and verified the same complete PDF in every request. One initial request warmed the connection and was excluded, leaving three runs per mode.

| Mode                | Median first byte | Median full file | Individual full-file times |
| ------------------- | ----------------: | ---------------: | -------------------------- |
| Current, buffered   |          1,569 ms |         1,579 ms | 1,687; 1,465; 1,579 ms     |
| Prototype, streamed |            129 ms |         1,509 ms | 1,402; 1,630; 1,509 ms     |

Streaming advanced the first byte by about 1.44 seconds, but improved completion by only 70 ms in this sample, less than the variation between requests. The frontend waits for `response.blob()` before creating the iframe, so an earlier first byte does not directly make the PDF visible sooner. This was a local connection; a slow API-to-browser connection could behave differently. The prototype also did not solve how to return an HTTP error after sending bytes if the PDF exceeds the size limit.

## Browser: click to iframe load

The real page at `127.0.0.1:5174` was instrumented with `performance.now()`, `PerformanceResourceTiming`, and the iframe `load` event. The same PDF in a SEACE table row was opened through the real authenticated endpoint. The modal was closed before each repeat. Clicks were dispatched inside the page so automation tool latency did not enter the measurements.

| Lead time before click | Request completion relative to click | `blob:` iframe URL set | Iframe `load` event |
| ---------------------- | -----------------------------------: | ---------------------: | ------------------: |
| None, run 1            |                            ~2,624 ms |               2,734 ms |            2,791 ms |
| None, run 2            |                            ~3,121 ms |               3,219 ms |            3,238 ms |
| Hover 1 second         |                             1,946 ms |               2,036 ms |            2,047 ms |
| Hover 2 seconds        |                               781 ms |                 894 ms |              932 ms |
| Hover 9.66 seconds     |            6,724 ms **before** click |                 346 ms |              376 ms |

Prefetch started 251–265 ms after link intent. In the two clicks without a lead time, iframe `load` followed its `blob:` URL by 19–57 ms. The `load` event is a viewer readiness indicator, **not** an exact first-legible-pixel measurement; no frame-by-frame video was recorded. SEACE variability prevents attributing small differences to an optimization.

## Thumbnail and extraction

Two public PDFs were downloaded and inspected in memory with PyMuPDF:

| Document                    |        PDF size | Download | First-page text | First-page JPEG at 1.3× scale | Render and encode |
| --------------------------- | --------------: | -------: | --------------: | ----------------------------: | ----------------: |
| prod6 `433954`, seven pages | 2,338,665 bytes | 2,251 ms |    0 characters |                 117,506 bytes |            132 ms |
| prod4 `153221571`, one page |    76,129 bytes |   821 ms |    0 characters |                  81,020 bytes |             67 ms |

The large PDF contained a 294,201-byte embedded JPEG on its first page; extraction took about 1 ms **after** downloading the PDF. For the small PDF, the JPEG thumbnail was larger than the original PDF. Neither first page yields a useful text preview without OCR. Generating thumbnails on demand adds work to the first opening. Preparing or storing them in advance makes sense only for documents likely to be opened or reopened.

## Decision for this installation

The remaining wait is dominated by the PDF request; the native viewer adds little time after receiving the `blob:` URL. These results do not justify replacing it with PDF.js or adding streaming solely for latency on the local connection. Bounded prefetch has the clearest visible benefit. A possible next step is to measure how often the same PDF is reopened and, if frequent, retain **one** `Blob` briefly after closing the modal. Repeat the streaming comparison from a slow remote client before deciding whether to use it there.
