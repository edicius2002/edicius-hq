// THROWAWAY SPIKE: Vercel Queue -> Raspberry Pi -> private Blob -> browser.
// Keep this file on the spike branch only.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { get, head, issueSignedToken, presignUrl } from '@vercel/blob';

const topic = 'seace-spike';
const consumer = 'pi-spike';
const queueBase = `https://iad1.vercel-queue.com/api/v3/topic/${topic}`;
const maxPdfBytes = 30 * 1024 * 1024;

type Job = { id: string; kind: 'prod6' | 'process'; source: string };

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function workerAllowed(request: Request): boolean {
  const key = process.env.SEACE_SPIKE_WORKER_KEY;
  return !!key && equal(request.headers.get('x-spike-key') ?? '', key.trim());
}

function viewerSignature(id: string, expires: number): string {
  return createHmac('sha256', process.env.SEACE_SPIKE_WORKER_KEY ?? '')
    .update(`${id}.${expires}`)
    .digest('base64url');
}

function viewerAllowed(url: URL): boolean {
  const id = url.searchParams.get('id') ?? '';
  const expires = Number(url.searchParams.get('expires'));
  const token = url.searchParams.get('token') ?? '';
  return (
    /^[0-9a-f-]{36}$/.test(id) &&
    Number.isSafeInteger(expires) &&
    expires > Date.now() &&
    expires < Date.now() + 60 * 60 * 1000 + 60_000 &&
    equal(token, viewerSignature(id, expires))
  );
}

function blobPath(id: string): string {
  return `seace-spike/${id}.pdf`;
}

function queueToken(request: Request): string | null {
  return request.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN || null;
}

async function queueCall(
  request: Request,
  method: string,
  path: string,
  headers: HeadersInit = {},
  body?: string,
) {
  const token = queueToken(request);
  if (!token) return new Response('Queue OIDC unavailable', { status: 503 });
  return fetch(`${queueBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
}

async function ready(id: string): Promise<boolean> {
  try {
    const metadata = await head(blobPath(id));
    return metadata.contentType === 'application/pdf';
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!workerAllowed(request)) return new Response('Unauthorized', { status: 401 });
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'request') {
    const input = (await request.json()) as { kind?: string; source?: string };
    if (input.kind !== 'prod6' && input.kind !== 'process')
      return new Response('Invalid kind', { status: 400 });
    const source = input.source ?? '';
    if (
      (input.kind === 'prod6' &&
        !/^https:\/\/prod6\.seace\.gob\.pe\/v1\/s8uit-services\/archivo\/archivos-publico\/descargar-archivo-contrato\/[0-9]+$/.test(
          source,
        )) ||
      (input.kind === 'process' && !/^[0-9a-f-]{36}$/i.test(source))
    )
      return new Response('Invalid source', { status: 400 });
    const job: Job = { id: randomUUID(), kind: input.kind, source };
    const queued = await queueCall(
      request,
      'POST',
      '',
      { 'Content-Type': 'application/json', 'Vqs-Retention-Seconds': '600' },
      JSON.stringify(job),
    );
    if (queued.status !== 201 && queued.status !== 202)
      return new Response(`Queue send failed: ${queued.status}`, { status: 502 });
    const expires = Date.now() + 45 * 60 * 1000;
    const origin = new URL(request.url).origin;
    const params = new URLSearchParams({
      action: 'view',
      id: job.id,
      expires: String(expires),
      token: viewerSignature(job.id, expires),
    });
    return Response.json({ id: job.id, viewUrl: `${origin}/api/seace/spike?${params}` });
  }
  if (action === 'ack') {
    const input = (await request.json()) as { id?: string; receiptHandle?: string };
    if (
      !input.id ||
      !/^[0-9a-f-]{36}$/.test(input.id) ||
      !input.receiptHandle ||
      !(await ready(input.id))
    )
      return new Response('Not ready', { status: 409 });
    const ack = await queueCall(
      request,
      'DELETE',
      `/consumer/${consumer}/lease/${encodeURIComponent(input.receiptHandle)}`,
    );
    if (ack.status !== 204) return new Response(`Queue ack failed: ${ack.status}`, { status: 502 });
    return Response.json({ acknowledged: true });
  }
  return new Response('Unknown action', { status: 404 });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action === 'diag')
    return Response.json({
      workerKeyConfigured: !!process.env.SEACE_SPIKE_WORKER_KEY,
      workerHeaderPresent: request.headers.has('x-spike-key'),
      oidcPresent: !!queueToken(request),
      blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    });
  if (action === 'work') {
    if (!workerAllowed(request)) return new Response('Unauthorized', { status: 401 });
    const received = await queueCall(request, 'POST', `/consumer/${consumer}`, {
      Accept: 'application/x-ndjson',
      'Vqs-Visibility-Timeout-Seconds': '180',
    });
    if (received.status === 204) return new Response(null, { status: 204 });
    if (received.status !== 200)
      return new Response(`Queue receive failed: ${received.status}`, { status: 502 });
    const first = (await received.text()).trim().split('\n')[0];
    const message = JSON.parse(first) as { receiptHandle: string; body: string };
    const job = JSON.parse(Buffer.from(message.body, 'base64').toString('utf8')) as Job;
    if (!/^[0-9a-f-]{36}$/.test(job.id)) return new Response('Invalid job', { status: 502 });
    const pathname = blobPath(job.id);
    const signed = await issueSignedToken({
      pathname,
      operations: ['put'],
      validUntil: Date.now() + 10 * 60 * 1000,
      allowedContentTypes: ['application/pdf'],
      maximumSizeInBytes: maxPdfBytes,
    });
    const { presignedUrl } = await presignUrl(signed, {
      operation: 'put',
      pathname,
      access: 'private',
      validUntil: Date.now() + 10 * 60 * 1000,
      allowedContentTypes: ['application/pdf'],
      maximumSizeInBytes: maxPdfBytes,
      ttlDays: 1,
    });
    return Response.json({ job, receiptHandle: message.receiptHandle, uploadUrl: presignedUrl });
  }
  if (!viewerAllowed(url)) return new Response('Unauthorized', { status: 401 });
  const id = url.searchParams.get('id')!;
  if (action === 'status')
    return Response.json({ ready: await ready(id) }, { headers: { 'Cache-Control': 'no-store' } });
  if (action === 'file') {
    const blob = await get(blobPath(id), { access: 'private' });
    if (!blob || blob.statusCode !== 200 || !blob.stream)
      return new Response('Not found', { status: 404 });
    return new Response(blob.stream, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="seace-preview.pdf"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (action === 'view') {
    const query = new URLSearchParams({
      id,
      token: url.searchParams.get('token')!,
      expires: url.searchParams.get('expires')!,
    });
    const statusUrl = `/api/seace/spike?action=status&${query}`;
    const fileUrl = `/api/seace/spike?action=file&${query}`;
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>SEACE preview spike</title></head><body style="margin:0;font:16px system-ui"><div id="status" style="padding:12px">Waiting for Pi...</div><iframe id="pdf" title="SEACE PDF" style="width:100%;height:calc(100dvh - 48px);border:0;display:none"></iframe><script>const statusUrl=${JSON.stringify(statusUrl)},fileUrl=${JSON.stringify(fileUrl)};async function poll(){try{let r=await fetch(statusUrl,{cache:'no-store'});let j=await r.json();if(j.ready){document.getElementById('status').textContent='PDF ready';document.getElementById('pdf').src=fileUrl;document.getElementById('pdf').style.display='block';return}}catch{}setTimeout(poll,1500)}poll()</script></body></html>`;
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response('Unknown action', { status: 404 });
}
