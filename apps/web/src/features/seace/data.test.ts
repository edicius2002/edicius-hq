import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), rpc: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({
  supabase: { from: () => ({ upsert: mocks.upsert }), rpc: mocks.rpc },
}));

import { loadSeacePage, setExcludedMany } from './data';

beforeEach(() => {
  mocks.upsert.mockReset();
  mocks.upsert.mockResolvedValue({ error: null });
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
