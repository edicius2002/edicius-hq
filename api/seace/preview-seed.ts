// TEMPORARY Preview-only integration harness. Remove before merge.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BlobNotFoundError, get } from '@vercel/blob';
import { allowedSource } from './previewCore.js';
import type { Manifest, PreviewJob } from './previewCore.js';

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
function denied(request: Request): Response | null {
  if (process.env.VERCEL_ENV !== 'preview') return response({ error: 'Not found' }, 404);
  const key = process.env.SEACE_PREVIEW_WORKER_KEY?.trim();
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${key ?? ''}`);
  if (!key || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return response({ error: 'Unauthorized' }, 401);
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const denial = denied(request);
  if (denial) return denial;
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 4000) return response({ error: 'Invalid request' }, 400);
    input = JSON.parse(text);
  } catch {
    return response({ error: 'Invalid request' }, 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return response({ error: 'Invalid request' }, 400);
  const data = input as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    typeof data.source !== 'string' ||
    !(
      (data.kind === 'url' && allowedSource(data.source)) ||
      (data.kind === 'process' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.source))
    )
  )
    return response({ error: 'Invalid request' }, 400);
  try {
    const region = process.env.SEACE_PREVIEW_QUEUE_REGION ?? 'iad1';
    const topic = process.env.SEACE_PREVIEW_QUEUE_TOPIC ?? 'seace-preview';
    const token = request.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN;
    if (!token || !/^[a-z]{3}\d$/.test(region) || !/^[A-Za-z0-9_-]{1,128}$/.test(topic))
      return response({ error: 'Harness unavailable' }, 503);
    const job: PreviewJob = {
      id: randomBytes(32).toString('hex'),
      kind: data.kind as PreviewJob['kind'],
      source: data.source,
      expiresAt: Date.now() + 20 * 60_000,
    };
    const queued = await fetch(`https://${region}.vercel-queue.com/api/v3/topic/${topic}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Vqs-Retention-Seconds': '1200',
        'Vqs-Idempotency-Key': job.id,
      },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(20_000),
    });
    if (!queued.ok) return response({ error: 'Harness unavailable' }, 503);
    return response({ jobId: job.id });
  } catch {
    return response({ error: 'Harness unavailable' }, 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  const denial = denied(request);
  if (denial) return denial;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[a-f0-9]{64}$/.test(id)) return response({ error: 'Invalid request' }, 400);
  try {
    const blob = await get(`seace-preview/v1/${id}/result.json`, {
      access: 'private',
      useCache: false,
    });
    if (!blob) return response({ status: 'pending' });
    if (blob.statusCode !== 200 || blob.blob.size > 20_000)
      return response({ error: 'Harness unavailable' }, 503);
    const manifest = (await new Response(blob.stream).json()) as Manifest;
    if (
      !['ready', 'unsupported', 'failed'].includes(manifest.status) ||
      !Array.isArray(manifest.files)
    )
      return response({ error: 'Harness unavailable' }, 503);
    return response({
      status: manifest.status,
      files: manifest.files.map(({ index, name, size }) => ({ index, name, size })),
    });
  } catch (error) {
    if (error instanceof BlobNotFoundError) return response({ status: 'pending' });
    return response({ error: 'Harness unavailable' }, 503);
  }
}
