import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  in: vi.fn(),
  filter: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    from: () => ({ upsert: mocks.upsert, delete: mocks.delete }),
    rpc: mocks.rpc,
  },
}));

import {
  loadSeaceDocument,
  loadSeacePreview,
  loadSeacePage,
  SeacePartialRestoreError,
  setExcluded,
  setExcludedMany,
} from './data';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('loads the production PDF from the same Vercel origin', async () => {
  vi.stubEnv('DEV', false);
  const fetcher = vi.fn().mockResolvedValue(new Response('%PDF-test'));
  vi.stubGlobal('fetch', fetcher);

  expect(await (await loadSeaceDocument('https://prod6.seace.gob.pe/example.pdf')).text()).toBe(
    '%PDF-test',
  );
  expect(fetcher).toHaveBeenCalledWith(
    '/api/seace/document?url=https%3A%2F%2Fprod6.seace.gob.pe%2Fexample.pdf',
    { signal: expect.any(AbortSignal), credentials: 'same-origin' },
  );
});

beforeEach(() => {
  mocks.upsert.mockReset();
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.delete.mockReset();
  mocks.delete.mockReturnValue({ eq: mocks.eq, in: mocks.in, filter: mocks.filter });
  mocks.eq.mockReset();
  mocks.eq.mockResolvedValue({ error: null });
  mocks.in.mockReset();
  mocks.in.mockResolvedValue({ error: null });
  mocks.filter.mockReset();
  mocks.filter.mockResolvedValue({ error: null });
  mocks.rpc.mockReset();
});

it('returns one server-filtered page and its exact total', async () => {
  mocks.rpc.mockResolvedValue({
    data: { total: 61, rows: [{ kind: 'notices', recordKey: 'A', payload: { code: 'CM-A' } }] },
    error: null,
  });

  const page = await loadSeacePage({
    region: 'Arequipa',
    year: 2026,
    view: 'recent',
    minorOnly: true,
    objectFilter: 'Todos',
    excluded: false,
    search: '',
    sortField: 'published',
    ascending: false,
    page: 2,
    pageSize: 50,
    now: '2026-10-24T12:00:00.000Z',
  });

  expect(page).toEqual({
    total: 61,
    rows: [{ kind: 'notices', recordKey: 'A', payload: { code: 'CM-A' } }],
  });
  expect(mocks.rpc).toHaveBeenCalledWith('read_owner_seace_page', {
    p_region: 'Arequipa',
    p_year: 2026,
    p_view: 'recent',
    p_minor_only: true,
    p_object_filter: 'Todos',
    p_excluded: false,
    p_search: '',
    p_sort_field: 'published',
    p_ascending: false,
    p_page: 2,
    p_page_size: 50,
    p_now: '2026-10-24T12:00:00.000Z',
  });
});

it('uses database defaults for the owner ID when importing multiple keys', async () => {
  await setExcludedMany(['minor:["Arequipa","CM-1"]'], true);

  expect(mocks.upsert).toHaveBeenCalledWith([{ record_key: 'minor:["Arequipa","CM-1"]' }], {
    onConflict: 'owner_id,record_key',
    ignoreDuplicates: true,
    defaultToNull: false,
  });
});

it('escapes JSON-shaped keys in one batch restore request', async () => {
  await setExcludedMany(['minor:["Arequipa","CM-1"]', String.raw`minor:["A\B","C"]`], false);

  expect(mocks.delete).toHaveBeenCalledTimes(1);
  expect(mocks.filter).toHaveBeenCalledWith(
    'record_key',
    'in',
    String.raw`("minor:[\"Arequipa\",\"CM-1\"]","minor:[\"A\\B\",\"C\"]")`,
  );
});

const longKeys = () =>
  Array.from(
    { length: 100 },
    (_, index) =>
      `process:${JSON.stringify(['Arequipa', `P-${index}`, '2026-10-25', 'X'.repeat(160)])}`,
  );

it('bounds encoded batch restore filters for 100 long keys', async () => {
  await setExcludedMany(longKeys(), false);

  expect(mocks.filter.mock.calls.length).toBeGreaterThan(1);
  for (const [column, operator, value] of mocks.filter.mock.calls) {
    expect(column).toBe('record_key');
    expect(operator).toBe('in');
    expect(
      new URLSearchParams({ record_key: `in.${String(value)}` }).toString().length,
    ).toBeLessThanOrEqual(6000);
  }
});

it('marks a restore error as partial after an earlier chunk succeeded', async () => {
  mocks.filter.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({
    error: { code: '503' },
  });

  await expect(setExcludedMany(longKeys(), false)).rejects.toBeInstanceOf(SeacePartialRestoreError);
});

it('uses raw equality for one JSON-shaped key', async () => {
  const key = 'minor:["Arequipa","CM-1"]';
  await setExcludedMany([key], false);

  expect(mocks.eq).toHaveBeenCalledWith('record_key', key);
  expect(mocks.filter).not.toHaveBeenCalled();
});

it('uses raw equality for the single-record restore path', async () => {
  const key = 'minor:["Arequipa","CM-1"]';
  await setExcluded(key, false);

  expect(mocks.eq).toHaveBeenCalledWith('record_key', key);
  expect(mocks.filter).not.toHaveBeenCalled();
});

const previewRow = { kind: 'processes' as const, recordKey: 'record' };
const previewDocument = { uuid: '12345678-1234-1234-1234-123456789abc' };
const readyPreview = {
  jobId: 'job',
  ticket: 'ticket',
  status: 'ready',
  files: [
    { index: 0, name: 'First.pdf' },
    { index: 1, name: 'Second.pdf' },
  ],
};

it('requests a cookie-authenticated same-origin preview and returns all PDF streams', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(readyPreview)));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(await loadSeacePreview(previewRow, previewDocument, signal)).toEqual([
    { index: 0, name: 'First.pdf', url: '/api/seace/preview-file?jobId=job&ticket=ticket&file=0' },
    { index: 1, name: 'Second.pdf', url: '/api/seace/preview-file?jobId=job&ticket=ticket&file=1' },
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    '/api/seace/preview',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ ...previewRow, document: previewDocument }),
    }),
  );
});

it('polls pending previews after two seconds and then stops when ready', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ jobId: 'job', ticket: 'ticket', status: 'pending' })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(readyPreview)));
  vi.stubGlobal('fetch', fetcher);
  const pending = loadSeacePreview(previewRow, previewDocument, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toHaveLength(2);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/seace/preview?jobId=job&ticket=ticket',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('stops polling when the dialog request is aborted', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ jobId: 'job', ticket: 'ticket', status: 'pending' })),
    );
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const pending = loadSeacePreview(previewRow, previewDocument, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('bounds an offline worker wait to 90 seconds', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ jobId: 'job', ticket: 'ticket', status: 'pending' })),
    );
  vi.stubGlobal('fetch', fetcher);
  const pending = loadSeacePreview(previewRow, previewDocument, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('taking too long');
  await vi.advanceTimersByTimeAsync(90000);
  await rejected;
  const calls = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(calls);
});

it('reports unsupported archives without treating them as PDFs', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ jobId: 'job', ticket: 'ticket', status: 'unsupported' })),
      ),
  );
  await expect(
    loadSeacePreview(previewRow, previewDocument, new AbortController().signal),
  ).rejects.toThrow('No supported PDF');
});

it('bounds a stalled direct PDF attempt without aborting the modal fallback signal', async () => {
  vi.useFakeTimers();
  vi.stubEnv('DEV', false);
  const controller = new AbortController();
  const fetcher = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const pending = loadSeaceDocument('https://prod4.seace.gob.pe/example.pdf', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(14999);
  expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(controller.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts a direct PDF when its modal is closed', async () => {
  vi.stubEnv('DEV', false);
  const controller = new AbortController();
  const fetcher = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const pending = loadSeaceDocument('https://prod4.seace.gob.pe/example.pdf', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
});
