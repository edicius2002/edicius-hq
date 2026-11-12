# SEACE integrated PDF preview: end-to-end spike

Date: 2026-11-12. This records a throwaway test of the architecture proposed in [the feasibility study](seace-integrated-preview-options.md). The tested code is isolated on [`spike/seace-integrated-preview`](https://github.com/edicius2002/edicius-hq/tree/spike/seace-integrated-preview) at `a0544ed`; it is not merged into the application or deployed to production.

## Tested path

1. A protected Vercel Preview Function accepted a validated SEACE document identifier, sent a job to Vercel Queues, and returned an opaque job ID with a short-lived view link.
2. A one-shot Python worker on the Raspberry Pi polled the Function outbound. The Function used its Vercel OIDC token to receive the Queue lease and issued a path-specific, time-limited signed PUT for a private Vercel Blob store. The Pi never received the Queue OIDC token and required no inbound port, domain, or tunnel.
3. The Pi fetched the source document from SEACE, checked its bytes, uploaded the PDF directly to private Blob, and acknowledged the Queue lease only after the upload. The viewer polled Blob status and loaded the PDF through a same-origin Vercel Function stream with `application/pdf`, `inline`, and `private, no-store` headers.

| Source case                  | Observed result                                                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prod6` numeric download URL | The Pi fetched a PDF of 186,440 bytes and uploaded it; the status endpoint reported ready. The same-origin file endpoint returned HTTP 200 and the complete `%PDF-` file.                                                                                                                    |
| Process document UUID        | Alfresco resolved the UUID to a 13,981,918-byte ZIP containing one PDF and one RAR. The worker selected the PDF after bounded ZIP inspection and uploaded 14,663,456 PDF bytes. The file endpoint streamed all bytes with HTTP 200; a browser rendered its first page and reported 90 pages. |
| Missing credentials          | The request endpoint and file endpoint each returned HTTP 401.                                                                                                                                                                                                                               |

Desktop Chromium at 1280×900 displayed the first page inside the page's `iframe`. Android-sized Chromium emulation at 390×844 also displayed PDF pages inside the page. Both browser runs observed an HTTP 200 PDF response. This proves the private same-origin streaming route works with a PDF larger than Vercel's ordinary 4.5 MB response-body limit in these two browser configurations. It does **not** prove rendering on a physical phone, Safari, or every PDF format.

The spike used a worker key and a signed view link. It did **not** use the app's Neon Auth session, check a document against a user's visible SEACE record, implement the production modal, run a persistent Pi service, or test offline/retry behavior. Those are implementation and release gates. The two documents establish feasibility of the `prod6` and ZIP-with-PDF paths, not coverage of all stored SEACE links or UUIDs. A ZIP without a safe PDF must retain the original-download fallback.

## Implementation consequences

- Keep the existing fast `prod4` route. Use the Pi path for `prod6`, suitable resolved process PDFs, and `prod4` failures. Do not present a ZIP or RAR as a PDF.
- Replace the spike's worker key on the user-facing request/status/file routes with the real session and a server-side record-access check. Keep a separate narrow credential for Pi work and acknowledgement. Never expose Queue OIDC, Blob write tokens, source download URLs, or signed PUT URLs to the browser or logs.
- Use immutable Blob paths, short signed PUT lifetimes, a one-day TTL, size and ZIP limits, bounded polling and wait time, deduplication, and an immediate original-link fallback. Measure Queue operations, Function invocations, Blob storage and transfer against the account limits before release.
- Test a physical Android device and iPhone/Safari, Pi restart and duplicate Queue delivery, expired signed PUT, SEACE denial, unsupported files, oversized ZIPs, and quota exhaustion. The production UI should offer each safe PDF member when a ZIP contains more than one.

The spike did not change production data or services. All preview PDF objects were configured with a one-day Blob TTL.
