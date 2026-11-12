import { BlobNotFoundError, get, head, issueSignedToken, presignUrl, put } from '@vercel/blob';
import { Pool } from 'pg';
import { createPreviewService, MAX_PDF_BYTES } from './previewCore.js';
import type { Manifest, PreviewFile, PreviewJob } from './previewCore.js';

let pool: Pool | undefined;
const prefix = 'seace-preview/v1';
const manifestPath = (id: string) => `${prefix}/${id}/result.json`;
const pdfPath = (id: string, index: number) => `${prefix}/${id}/${index}.pdf`;
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Preview configuration unavailable');
  return value;
}

async function readManifest(id: string): Promise<Manifest | null> {
  try {
    const result = await get(manifestPath(id), { access: 'private', useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || result.blob.size > 20_000)
      throw new Error('Invalid preview manifest');
    return (await new Response(result.stream).json()) as Manifest;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}
async function verifyPdf(id: string, file: PreviewFile): Promise<boolean> {
  try {
    const metadata = await head(pdfPath(id, file.index));
    if (
      metadata.size !== file.size ||
      metadata.size > MAX_PDF_BYTES ||
      metadata.contentType !== 'application/pdf'
    )
      return false;
    const result = await get(pdfPath(id, file.index), { access: 'private' });
    if (!result || result.statusCode !== 200) return false;
    const reader = result.stream.getReader();
    const bytes = new Uint8Array(5);
    let count = 0;
    try {
      while (count < 5) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const length = Math.min(5 - count, chunk.value.length);
        bytes.set(chunk.value.subarray(0, length), count);
        count += length;
      }
    } finally {
      await reader.cancel();
    }
    return count === 5 && new TextDecoder().decode(bytes) === '%PDF-';
  } catch (error) {
    if (error instanceof BlobNotFoundError) return false;
    throw error;
  }
}

export function previewService(request: Request) {
  const secret = required('SEACE_PREVIEW_TICKET_SECRET');
  if (secret.length < 32) throw new Error('Preview configuration unavailable');
  const region = process.env.SEACE_PREVIEW_QUEUE_REGION ?? 'iad1';
  const topic = process.env.SEACE_PREVIEW_QUEUE_TOPIC ?? 'seace-preview';
  const consumer = process.env.SEACE_PREVIEW_QUEUE_CONSUMER ?? 'pi-preview';
  if (
    !/^[a-z]{3}\d$/.test(region) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(topic) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(consumer)
  )
    throw new Error('Invalid Queue configuration');
  const queueBase = `https://${region}.vercel-queue.com/api/v3/topic/${topic}`;
  async function queue(
    method: string,
    path: string,
    headers: HeadersInit = {},
    body?: string,
  ): Promise<Response> {
    // Vercel injects this header; never forward it to the browser or worker.
    const token = request.headers.get('x-vercel-oidc-token') || required('VERCEL_OIDC_TOKEN');
    const response = await fetch(queueBase + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Queue unavailable');
    return response;
  }
  return createPreviewService({
    secret,
    workerKey: required('SEACE_PREVIEW_WORKER_KEY'),
    now: Date.now,
    async session(req) {
      if (!req.headers.has('cookie')) return null;
      const { auth } = await import('../auth.js');
      return (await auth.api.getSession({ headers: req.headers }))?.user.id ?? null;
    },
    async record(owner, kind, key) {
      pool ??= new Pool({
        connectionString: required('DATABASE_URL'),
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
      // The server connection can bypass RLS: bind both the owner and owner registry explicitly.
      const result = await pool.query<{ payload: Record<string, unknown> }>(
        'SELECT r.payload FROM public.seace_records r JOIN public.edicius_owners o ON o.owner_id=r.owner_id WHERE r.owner_id::text=$1 AND r.kind=$2 AND r.record_key=$3 LIMIT 1',
        [owner, kind, key],
      );
      return result.rows[0]?.payload ?? null;
    },
    async send(job) {
      await queue(
        'POST',
        '',
        {
          'Content-Type': 'application/json',
          'Vqs-Retention-Seconds': '1200',
          'Vqs-Idempotency-Key': job.id,
        },
        JSON.stringify(job),
      );
    },
    async receive() {
      const response = await queue('POST', `/consumer/${consumer}`, {
        Accept: 'application/x-ndjson',
        'Vqs-Max-Messages': '1',
        'Vqs-Visibility-Timeout-Seconds': '600',
      });
      if (response.status === 204) return null;
      const message = JSON.parse((await response.text()).trim().split('\n')[0]) as {
        receiptHandle: string;
        body: string;
      };
      if (typeof message.receiptHandle !== 'string' || typeof message.body !== 'string')
        throw new Error('Invalid Queue message');
      return {
        receiptHandle: message.receiptHandle,
        job: JSON.parse(Buffer.from(message.body, 'base64').toString('utf8')) as PreviewJob,
      };
    },
    async ack(receipt) {
      await queue('DELETE', `/consumer/${consumer}/lease/${encodeURIComponent(receipt)}`);
    },
    manifest: readManifest,
    async saveManifest(id, manifest) {
      try {
        await put(manifestPath(id), JSON.stringify(manifest), {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: false,
          ttlDays: 1,
        });
      } catch (error) {
        // Concurrent duplicate deliveries may have committed the same immutable result.
        if (!(await readManifest(id))) throw error;
      }
    },
    async upload(id, file) {
      const pathname = pdfPath(id, file.index),
        validUntil = Date.now() + 10 * 60_000;
      const signed = await issueSignedToken({
        pathname,
        operations: ['put'],
        validUntil,
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: file.size,
      });
      const { presignedUrl } = await presignUrl(signed, {
        operation: 'put',
        pathname,
        access: 'private',
        validUntil,
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: file.size,
        addRandomSuffix: false,
        allowOverwrite: false,
        ttlDays: 1,
      });
      return presignedUrl;
    },
    verify: verifyPdf,
    async file(id, file) {
      const result = await get(pdfPath(id, file.index), { access: 'private' });
      if (
        !result ||
        result.statusCode !== 200 ||
        result.blob.contentType !== 'application/pdf' ||
        result.blob.size !== file.size
      )
        return new Response(null, { status: 404 });
      return new Response(result.stream, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(file.size),
          'Content-Disposition': 'inline; filename="seace-preview.pdf"',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Accept-Ranges': 'none',
        },
      });
    },
  });
}

export async function handlePreview(
  request: Request,
  action: 'request' | 'status' | 'file' | 'work' | 'workerPost',
): Promise<Response> {
  try {
    return await previewService(request)[action](request);
  } catch {
    return Response.json(
      { error: 'Preview temporarily unavailable' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
