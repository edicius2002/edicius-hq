import { beforeEach, expect, it, vi } from 'vitest';

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

import { loadSeacePage, SeacePartialRestoreError, setExcluded, setExcludedMany } from './data';

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
