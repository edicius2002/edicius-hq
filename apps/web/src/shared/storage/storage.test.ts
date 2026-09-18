import { afterEach, describe, expect, it, vi } from 'vitest';

const { readRemoteDocument, writeRemoteDocument } = vi.hoisted(() => ({
  readRemoteDocument: vi.fn(),
  writeRemoteDocument: vi.fn(),
}));

vi.mock('@/shared/storage/supabaseStorage', () => ({ readRemoteDocument, writeRemoteDocument }));

import { readStorage, removeStorage, writeStorage } from '@/shared/storage/storage';

afterEach(() => {
  vi.clearAllMocks();
});

describe('storage facade', () => {
  it('preserves payload-only callers while reading and writing a revisioned document', async () => {
    readRemoteDocument
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ key: 'prefs', payload: { theme: 'light' }, revision: 1 })
      .mockResolvedValueOnce({ key: 'prefs', payload: { theme: 'light' }, revision: 1 });
    writeRemoteDocument.mockResolvedValue({
      key: 'prefs',
      payload: { theme: 'light' },
      revision: 1,
    });

    await expect(readStorage('prefs')).resolves.toBeNull();
    await expect(writeStorage('prefs', { theme: 'light' })).resolves.toEqual({ theme: 'light' });
    await expect(readStorage('prefs')).resolves.toEqual({ theme: 'light' });
    await expect(removeStorage('prefs')).resolves.toBeUndefined();
    expect(writeRemoteDocument).toHaveBeenNthCalledWith(1, 'prefs', { theme: 'light' }, 0);
    expect(writeRemoteDocument).toHaveBeenNthCalledWith(2, 'prefs', null, 1);
  });

  it('rejects unknown keys before calling Supabase', async () => {
    await expect(writeStorage('not-allowed' as never, 1)).rejects.toThrow(/not allowlisted/);
    expect(readRemoteDocument).not.toHaveBeenCalled();
  });

  it('leaves an old chart-views document untouched', async () => {
    await expect(readStorage('chart-views' as never)).rejects.toThrow(/not allowlisted/);
    expect(readRemoteDocument).not.toHaveBeenCalled();
  });
});
