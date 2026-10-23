import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({
  supabase: { from: () => ({ upsert: mocks.upsert }) },
}));

import { setExcludedMany } from './data';

beforeEach(() => {
  mocks.upsert.mockReset();
  mocks.upsert.mockResolvedValue({ error: null });
});

it('uses database defaults for the owner ID when importing multiple keys', async () => {
  await setExcludedMany(['minor:["Arequipa","CM-1"]'], true);

  expect(mocks.upsert).toHaveBeenCalledWith([{ record_key: 'minor:["Arequipa","CM-1"]' }], {
    onConflict: 'owner_id,record_key',
    ignoreDuplicates: true,
    defaultToNull: false,
  });
});
