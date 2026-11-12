import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const MAX_PDF_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 5;
const WINDOW = 10 * 60_000;
export type PreviewJob = { id: string; kind: 'url' | 'process'; source: string; expiresAt: number };
export type PreviewFile = { index: number; name: string; size: number };
export type Manifest = { status: 'ready' | 'unsupported' | 'failed'; files: PreviewFile[] };
type Descriptor = {
  owner: string;
  kind: string;
  recordKey: string;
  document: { url?: string; uuid?: string };
  job: PreviewJob;
  viewExpiresAt: number;
};
type Lease = { job: PreviewJob; receiptHandle: string; expiresAt: number };
export type PreviewDependencies = {
  secret: string;
  workerKey: string;
  now: () => number;
  session: (request: Request) => Promise<string | null>;
  record: (owner: string, kind: string, key: string) => Promise<Record<string, unknown> | null>;
  send: (job: PreviewJob) => Promise<void>;
  receive: () => Promise<{ job: PreviewJob; receiptHandle: string } | null>;
  ack: (receipt: string) => Promise<void>;
  manifest: (id: string) => Promise<Manifest | null>;
  saveManifest: (id: string, manifest: Manifest) => Promise<void>;
  upload: (id: string, file: PreviewFile) => Promise<string>;
  verify: (id: string, file: PreviewFile) => Promise<boolean>;
  file: (id: string, file: PreviewFile, request: Request) => Promise<Response>;
};
export function allowedSource(source: string): boolean {
  try {
    const u = new URL(source);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return false;
    return (
      (u.hostname === 'prod4.seace.gob.pe' &&
        u.port === '9000' &&
        /^\/api\/con\/documentos\/descargar\/\d+$/.test(u.pathname)) ||
      (u.hostname === 'prod6.seace.gob.pe' &&
        !u.port &&
        /^\/v1\/s8uit-services\/archivo\/archivos-publico\/descargar-archivo-contrato\/\d+$/.test(
          u.pathname,
        ))
    );
  } catch {
    return false;
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validJob(job: PreviewJob): boolean {
  return (
    !!job &&
    /^[a-f0-9]{64}$/.test(job.id) &&
    Number.isSafeInteger(job.expiresAt) &&
    ((job.kind === 'url' && allowedSource(job.source)) ||
      (job.kind === 'process' && uuid.test(job.source)))
  );
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function member(value: unknown): value is PreviewFile {
  if (!value || typeof value !== 'object') return false;
  const f = value as PreviewFile;
  return (
    Number.isInteger(f.index) &&
    f.index >= 0 &&
    f.index < MAX_FILES &&
    typeof f.name === 'string' &&
    f.name.length > 0 &&
    f.name.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(f.name) &&
    Number.isSafeInteger(f.size) &&
    f.size >= 5 &&
    f.size <= MAX_PDF_BYTES
  );
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
function fail(status: number): never {
  throw new Response(null, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 20_000) fail(413);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400);
    return value;
  } catch {
    return fail(400);
  }
}
export function createPreviewService(d: PreviewDependencies) {
  const key = createHash('sha256').update(d.secret).digest();
  function seal(value: unknown, purpose: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  function open<T>(token: string, purpose: string): T {
    try {
      if (token.length > 16000) fail(403);
      const bytes = Buffer.from(token, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(purpose));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
      );
    } catch {
      return fail(403);
    }
  }
  async function owns(
    owner: string,
    desc: Pick<Descriptor, 'kind' | 'recordKey' | 'document'>,
  ): Promise<boolean> {
    const payload = await d.record(owner, desc.kind, desc.recordKey);
    if (!payload) return false;
    const docs = [
      { url: payload.documentUrl },
      ...(Array.isArray(payload.documents) ? payload.documents : []),
    ];
    return docs.some(
      (doc) =>
        doc &&
        typeof doc === 'object' &&
        (desc.document.url ? doc.url === desc.document.url : doc.uuid === desc.document.uuid),
    );
  }
  async function viewer(request: Request): Promise<Descriptor> {
    const owner = await d.session(request);
    if (!owner) fail(401);
    const url = new URL(request.url);
    const desc = open<Descriptor>(url.searchParams.get('ticket') ?? '', 'viewer');
    if (desc.owner !== owner || desc.job.id !== url.searchParams.get('jobId')) fail(403);
    if (!(await owns(owner, desc))) fail(404);
    return desc;
  }
  function worker(request: Request) {
    if (!d.workerKey || !same(request.headers.get('authorization') ?? '', `Bearer ${d.workerKey}`))
      fail(401);
  }
  function safe(fn: (request: Request) => Promise<Response>) {
    return async (request: Request) => {
      try {
        return await fn(request);
      } catch (e) {
        return e instanceof Response ? e : json({ error: 'Preview temporarily unavailable' }, 503);
      }
    };
  }
  return {
    request: safe(async (request) => {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) fail(403);
      const owner = await d.session(request);
      if (!owner) fail(401);
      const input = await body(request);
      if (
        !['notices', 'processes', 'contracts'].includes(String(input.kind)) ||
        typeof input.recordKey !== 'string' ||
        input.recordKey.length > 4000 ||
        !input.recordKey ||
        !input.document ||
        typeof input.document !== 'object'
      )
        fail(400);
      const doc = input.document as { url?: string; uuid?: string };
      if (
        !!doc.url === !!doc.uuid ||
        (doc.url && (typeof doc.url !== 'string' || !allowedSource(doc.url))) ||
        (doc.uuid && (typeof doc.uuid !== 'string' || !uuid.test(doc.uuid)))
      )
        fail(400);
      const descriptor = {
        owner,
        kind: input.kind as string,
        recordKey: input.recordKey,
        document: doc,
      };
      if (!(await owns(owner, descriptor))) fail(404);
      const bucket = Math.floor(d.now() / WINDOW);
      const id = createHmac('sha256', key)
        .update(
          JSON.stringify([
            owner,
            descriptor.kind,
            descriptor.recordKey,
            doc.url ?? doc.uuid,
            bucket,
          ]),
        )
        .digest('hex');
      const job: PreviewJob = {
        id,
        kind: doc.url ? 'url' : 'process',
        source: (doc.url ?? doc.uuid)!,
        expiresAt: (bucket + 2) * WINDOW,
      };
      const manifest = await d.manifest(id);
      if (!manifest) await d.send(job);
      const viewExpiresAt = d.now() + 2 * 60 * 60_000;
      return json({
        jobId: id,
        ticket: seal({ ...descriptor, job, viewExpiresAt }, 'viewer'),
        status: manifest?.status ?? 'pending',
        files: manifest?.files.map(({ index, name }) => ({ index, name })),
        expiresAt: job.expiresAt,
        viewExpiresAt,
      });
    }),
    status: safe(async (request) => {
      const desc = await viewer(request);
      if (!Number.isSafeInteger(desc.viewExpiresAt) || desc.viewExpiresAt <= d.now())
        return json({ status: 'expired' });
      const manifest = await d.manifest(desc.job.id);
      if (!manifest && desc.job.expiresAt <= d.now()) return json({ status: 'expired' });
      return json({
        status: manifest?.status ?? 'pending',
        files: manifest?.files.map(({ index, name }) => ({ index, name })),
      });
    }),
    file: safe(async (request) => {
      const desc = await viewer(request);
      if (!Number.isSafeInteger(desc.viewExpiresAt) || desc.viewExpiresAt <= d.now()) fail(410);
      const index = Number(new URL(request.url).searchParams.get('file') ?? '0');
      const manifest = await d.manifest(desc.job.id);
      if (!manifest && desc.job.expiresAt <= d.now()) fail(410);
      const file =
        manifest?.status === 'ready' ? manifest.files.find((f) => f.index === index) : null;
      if (!file) fail(404);
      return d.file(desc.job.id, file, request);
    }),
    work: safe(async (request) => {
      worker(request);
      const received = await d.receive();
      if (!received) return new Response(null, { status: 204 });
      if (!validJob(received.job)) fail(502);
      if (received.job.expiresAt <= d.now() || (await d.manifest(received.job.id))) {
        await d.ack(received.receiptHandle);
        return new Response(null, { status: 204 });
      }
      return json({
        ...received,
        leaseToken: seal(
          { ...received, expiresAt: Math.min(d.now() + 600_000, received.job.expiresAt) },
          'worker',
        ),
      });
    }),
    workerPost: safe(async (request) => {
      worker(request);
      const input = await body(request);
      const lease = open<Lease>(String(input.leaseToken ?? ''), 'worker');
      if (
        lease.expiresAt <= d.now() ||
        lease.job.id !== input.jobId ||
        lease.receiptHandle !== input.receiptHandle
      )
        fail(403);
      if (input.action === 'upload') {
        if (!member(input.member)) fail(400);
        if (await d.verify(lease.job.id, input.member)) return json({ alreadyUploaded: true });
        return json({ uploadUrl: await d.upload(lease.job.id, input.member) });
      }
      if (
        input.action !== 'complete' ||
        !['ready', 'unsupported', 'failed'].includes(String(input.status))
      )
        fail(400);
      const files = input.files ?? [];
      if (
        !Array.isArray(files) ||
        files.length > MAX_FILES ||
        !files.every(member) ||
        new Set(files.map((f) => f.index)).size !== files.length ||
        (input.status === 'ready' ? files.length === 0 : files.length !== 0)
      )
        fail(400);
      const existing = await d.manifest(lease.job.id);
      if (!existing) {
        for (const file of files) if (!(await d.verify(lease.job.id, file))) fail(409);
        await d.saveManifest(lease.job.id, { status: input.status as Manifest['status'], files });
      }
      await d.ack(lease.receiptHandle);
      return json({ acknowledged: true });
    }),
  };
}
