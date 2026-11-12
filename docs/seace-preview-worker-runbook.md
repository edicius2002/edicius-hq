# SEACE preview worker

The Python worker polls the production Vercel origin outbound. It needs no incoming port, Queue OIDC token, Blob write token, database connection, or additional Python dependency. It processes one lease at a time. The installer ships its service disabled; normal release upgrades restart it only after an operator has enabled it.

## Configuration and activation

After the Vercel preview endpoints, private Blob store, Queue configuration and worker key are provisioned, create `/etc/edicius-hq/seace-preview.env` on the Pi as a regular root-owned file with mode `0600`. Set these values through a secure operator session; never paste them into logs or shell history:

```dotenv
SEACE_PREVIEW_BASE_URL=https://your-production-origin.example
SEACE_PREVIEW_WORKER_KEY=the-separate-worker-credential
SEACE_PREVIEW_POLL_SECONDS=10
```

The origin must use HTTPS and contain no path. The key must match the Vercel `SEACE_PREVIEW_WORKER_KEY`. The polling interval is constrained to 10–60 seconds; failure backoff reaches 60 seconds. Ten-second idle polling costs approximately 259,200 Function invocations and Queue receive operations per 30-day month, before real jobs and retries.

Deploy the pinned release through the existing Pi release process. Once the production API is ready and the environment file is installed, activate explicitly:

```sh
sudo systemctl enable --now edicius-seace-preview.service
sudo systemctl status edicius-seace-preview.service
sudo journalctl -u edicius-seace-preview.service -n 30 --no-pager
```

The service runs as `edicius-collector`, with a read-only filesystem, private temporary directory and a 384 MiB memory cap. It does not write downloaded documents to disk. Journals contain only fixed status markers and file counts; source URLs, signed PUT URLs, lease tokens and exception messages are deliberately absent. `SEACE_PREVIEW_RETRY` means the lease was left available for redelivery. Rotate the worker key on both sides and restart the service after a credential change.

## Protocol and limits

`GET /api/seace/preview-worker` uses `Authorization: Bearer …`. A 204 means idle; otherwise it returns `{job:{id,kind,source,expiresAt},receiptHandle,leaseToken}`. `kind` is `url` for an exact approved prod4/prod6 numeric download URL or `process` for a UUID. Every POST includes `jobId`, `receiptHandle` and `leaseToken`.

For each verified PDF the worker POSTs `{action:'upload',member:{index,name,size}}`. A returned `uploadUrl` receives a direct `application/pdf` PUT; `alreadyUploaded:true` skips an upload already verified by the server. Completion POSTs `{action:'complete',status:'ready',files:[{index,name,size}]}`. Unsupported or unsafe input completes with `unsupported`; invalid source identifiers complete with `failed`. Transient network, resolver, upload and API failures do not acknowledge the lease. Configure the Queue lease and upload authorization lifetime to accommodate up to five sequential uploads (at least ten minutes).

Downloads reject all redirects, use the proven `node` user agent and are capped at 30 MiB. PDFs require `%PDF-` bytes. ZIP inspection allows at most 20 entries, five PDF members, 30 MiB per entry, 60 MiB total expanded metadata and an expansion ratio of at most 100. Encrypted entries, traversal paths, absolute paths, drive paths and symlinks reject the archive. Non-PDF entries are never extracted, nested archives are never traversed, and each PDF is read with a hard output-byte cap and checked again. A ZIP containing a PDF and a RAR can offer the PDF while keeping the original ZIP available through the UI.

## Verification and rollback

Run `python -m pytest services/seace/tests/test_preview_worker.py ops/pi/tests/test_seace_preview_lifecycle.py` locally. Before release acceptance, exercise a prod6 PDF, a process ZIP with multiple PDFs, unsupported input, Pi restart during upload, duplicate delivery, expired upload authorization, SEACE denial and quota exhaustion. Verify the original-download action remains usable. Physical Android and iPhone/Safari rendering remain release checks; the earlier spike only exercised Chromium and mobile emulation.

To turn off processing, use `sudo systemctl disable --now edicius-seace-preview.service`; pending leases remain retryable and the web UI retains its fallback. When downgrading to a release that lacks the service, the current deploy script stops and disables the optional worker. Re-enabling after a later upgrade remains an explicit operator action. No worker, credential, Queue or Blob resource is provisioned by these repository changes.
