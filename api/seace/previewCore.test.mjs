import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewService, MAX_FILES } from './previewCore.ts';

const source = 'https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/123';
function setup() {
  const calls = [];
  let manifest = null;
  const deps = {
    secret: 'test-secret-that-is-long-enough-for-tests',
    workerKey: 'worker-key',
    now: () => 1000000,
    session: async () => 'owner',
    record: async () => ({ documentUrl: source }),
    send: async (job) => calls.push(job),
    manifest: async () => manifest,
    saveManifest: async (_id, value) => {
      manifest = value;
    },
    receive: async () => ({ job: calls[0], receiptHandle: 'receipt' }),
    ack: async () => calls.push('ack'),
    upload: async () => 'https://upload.invalid',
    verify: async () => true,
    file: async () => new Response('%PDF-test'),
  };
  return { deps, calls, service: createPreviewService(deps) };
}
const request = (body) =>
  new Request('https://app.test/api/seace/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.test' },
    body: JSON.stringify(body),
  });
const input = { kind: 'notices', recordKey: 'record', document: { url: source } };
test('API caps PDF members at the worker limit of five', async () => {
  assert.equal(MAX_FILES, 5);
  const { service } = setup();
  await service.request(request(input));
  const work = await (
    await service.work(
      new Request('https://app.test', { headers: { authorization: 'Bearer worker-key' } }),
    )
  ).json();
  const result = await service.workerPost(
    new Request('https://app.test', {
      method: 'POST',
      headers: { authorization: 'Bearer worker-key' },
      body: JSON.stringify({
        action: 'upload',
        jobId: work.job.id,
        receiptHandle: work.receiptHandle,
        leaseToken: work.leaseToken,
        member: { index: 5, name: 'sixth.pdf', size: 9 },
      }),
    }),
  );
  assert.equal(result.status, 400);
});
test('request requires session and record document membership before enqueue', async () => {
  const { deps, service, calls } = setup();
  deps.session = async () => null;
  assert.equal((await service.request(request(input))).status, 401);
  deps.session = async () => 'owner';
  assert.equal(
    (await service.request(request({ ...input, document: { url: source + '9' } }))).status,
    404,
  );
  assert.equal(calls.length, 0);
});
test('tickets bind owner and job, and jobs deduplicate within the time window', async () => {
  const { deps, service, calls } = setup();
  const a = await (await service.request(request(input))).json();
  const b = await (await service.request(request(input))).json();
  assert.equal(a.jobId, b.jobId);
  assert.equal(calls[0].id, a.jobId);
  const status = new Request(
    `https://app.test/api/seace/preview?jobId=${a.jobId}&ticket=${a.ticket}`,
  );
  assert.equal((await service.status(status)).status, 200);
  deps.session = async () => 'other';
  assert.equal((await service.status(status)).status, 403);
});
test('worker completion verifies every PDF before persisting and acknowledging', async () => {
  const { deps, service, calls } = setup();
  await service.request(request(input));
  const work = await (
    await service.work(
      new Request('https://app.test/api/seace/preview-worker', {
        headers: { authorization: 'Bearer worker-key' },
      }),
    )
  ).json();
  const complete = () =>
    new Request('https://app.test/api/seace/preview-worker', {
      method: 'POST',
      headers: { authorization: 'Bearer worker-key' },
      body: JSON.stringify({
        action: 'complete',
        jobId: work.job.id,
        receiptHandle: work.receiptHandle,
        leaseToken: work.leaseToken,
        status: 'ready',
        files: [{ index: 0, name: 'file.pdf', size: 9 }],
      }),
    });
  deps.verify = async () => false;
  assert.equal((await service.workerPost(complete())).status, 409);
  assert.equal(calls.includes('ack'), false);
  deps.verify = async () => true;
  assert.equal((await service.workerPost(complete())).status, 200);
  assert.equal(calls.includes('ack'), true);
});

test('rejects cross-origin creation, invalid sources and ambiguous selectors', async () => {
  const { service, calls } = setup();
  const cross = request(input);
  cross.headers.set('origin', 'https://other.test');
  assert.equal((await service.request(cross)).status, 403);
  for (const document of [
    { url: 'http://localhost/private' },
    { url: source, uuid: '123' },
    { uuid: 'invalid' },
  ]) {
    assert.equal((await service.request(request({ ...input, document }))).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('tampered and expired tickets cannot retrieve private files', async () => {
  const { service, deps } = setup();
  const result = await (await service.request(request(input))).json();
  const url = `https://app.test/api/seace/preview?jobId=${result.jobId}&ticket=${result.ticket}`;
  const tampered = new URL(url);
  tampered.searchParams.set('ticket', 'x' + result.ticket.slice(1));
  assert.equal((await service.status(new Request(tampered))).status, 403);
  const other = new URL(url);
  other.searchParams.set('jobId', '0'.repeat(64));
  assert.equal((await service.status(new Request(other))).status, 403);
  deps.now = () => result.expiresAt;
  assert.deepEqual(await (await service.status(new Request(url))).json(), { status: 'expired' });
  assert.equal((await service.file(new Request(url))).status, 410);
});

test('status rechecks record visibility after ticket issuance', async () => {
  const { service, deps } = setup();
  const result = await (await service.request(request(input))).json();
  deps.record = async () => null;
  assert.equal(
    (
      await service.status(
        new Request(`https://app.test/?jobId=${result.jobId}&ticket=${result.ticket}`),
      )
    ).status,
    404,
  );
});

test('completed PDFs remain viewable after queue expiry until the two-hour ticket expires', async () => {
  const { service, deps, calls } = setup();
  const result = await (await service.request(request(input))).json();
  assert.equal(result.viewExpiresAt, 1000000 + 2 * 60 * 60_000);
  const url = `https://app.test/?jobId=${result.jobId}&ticket=${result.ticket}`;
  deps.now = () => calls[0].expiresAt + 1;
  assert.deepEqual(await (await service.status(new Request(url))).json(), { status: 'expired' });
  deps.manifest = async () => ({
    status: 'ready',
    files: [
      { index: 0, name: 'first.pdf', size: 9 },
      { index: 1, name: 'second.pdf', size: 9 },
    ],
  });
  assert.equal((await (await service.status(new Request(url))).json()).status, 'ready');
  assert.equal((await service.file(new Request(url + '&file=1'))).status, 200);
  deps.now = () => result.viewExpiresAt;
  assert.deepEqual(await (await service.status(new Request(url))).json(), { status: 'expired' });
  assert.equal((await service.file(new Request(url + '&file=1'))).status, 410);
});

test('worker cannot swap a receipt, and retries skip verified immutable uploads', async () => {
  const { service, calls } = setup();
  assert.equal((await service.work(new Request('https://app.test'))).status, 401);
  await service.request(request(input));
  const work = await (
    await service.work(
      new Request('https://app.test', { headers: { authorization: 'Bearer worker-key' } }),
    )
  ).json();
  const post = (body) =>
    service.workerPost(
      new Request('https://app.test', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-key' },
        body: JSON.stringify(body),
      }),
    );
  const upload = {
    action: 'upload',
    jobId: work.job.id,
    receiptHandle: work.receiptHandle,
    leaseToken: work.leaseToken,
    member: { index: 0, name: 'safe.pdf', size: 9 },
  };
  assert.equal((await post({ ...upload, receiptHandle: 'different' })).status, 403);
  assert.deepEqual(await (await post(upload)).json(), { alreadyUploaded: true });
  assert.equal(calls.includes('ack'), false);
});

test('multiple PDFs are listed and only listed indices can stream', async () => {
  const { service } = setup();
  const result = await (await service.request(request(input))).json();
  const work = await (
    await service.work(
      new Request('https://app.test', { headers: { authorization: 'Bearer worker-key' } }),
    )
  ).json();
  const files = [
    { index: 0, name: 'first.pdf', size: 9 },
    { index: 1, name: 'second.pdf', size: 9 },
  ];
  const complete = () =>
    service.workerPost(
      new Request('https://app.test', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-key' },
        body: JSON.stringify({
          action: 'complete',
          jobId: work.job.id,
          receiptHandle: work.receiptHandle,
          leaseToken: work.leaseToken,
          status: 'ready',
          files,
        }),
      }),
    );
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 200);
  const url = `https://app.test/?jobId=${result.jobId}&ticket=${result.ticket}`;
  assert.deepEqual(await (await service.status(new Request(url))).json(), {
    status: 'ready',
    files: files.map(({ index, name }) => ({ index, name })),
  });
  assert.equal(await (await service.file(new Request(url + '&file=1'))).text(), '%PDF-test');
  assert.equal((await service.file(new Request(url + '&file=2'))).status, 404);
});

test('expired leases cannot upload or acknowledge and non-PDF results have no files', async () => {
  const { service, deps, calls } = setup();
  const result = await (await service.request(request(input))).json();
  const work = await (
    await service.work(
      new Request('https://app.test', { headers: { authorization: 'Bearer worker-key' } }),
    )
  ).json();
  const complete = (files = []) =>
    service.workerPost(
      new Request('https://app.test', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-key' },
        body: JSON.stringify({
          action: 'complete',
          jobId: work.job.id,
          receiptHandle: work.receiptHandle,
          leaseToken: work.leaseToken,
          status: 'unsupported',
          files,
        }),
      }),
    );
  assert.equal((await complete([{ index: 0, name: 'fake.pdf', size: 9 }])).status, 400);
  assert.equal((await complete()).status, 200);
  const url = `https://app.test/?jobId=${result.jobId}&ticket=${result.ticket}`;
  assert.deepEqual(await (await service.status(new Request(url))).json(), {
    status: 'unsupported',
    files: [],
  });
  assert.equal((await service.file(new Request(url))).status, 404);
  calls.length = 0;
  deps.now = () => 1600001;
  assert.equal((await complete()).status, 403);
  assert.equal(calls.length, 0);
});
