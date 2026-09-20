import { describe, expect, it, vi } from 'vitest';

const query = {
  select: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
};

vi.mock('@/shared/supabase/client', () => ({
  supabase: { from: vi.fn(() => query) },
}));

import { supabase } from '@/shared/supabase/client';
import { getLatestSentiment } from '@/features/sentiment/data/supabaseSentiment';

const response = {
  source: 'cnn' as const,
  fetchedAt: '2026-09-18T00:00:00Z',
  asOf: '2026-09-18T00:00:00Z',
  stale: false,
  composite: {
    key: 'fear_and_greed',
    label: 'Fear & Greed',
    score: 50,
    classification: 'neutral' as const,
    timestamp: '2026-09-18T00:00:00Z',
    series: [],
  },
  indicators: [],
};

describe('getLatestSentiment', () => {
  it('reads the newest owner-visible snapshot through Supabase RLS', async () => {
    query.select.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockResolvedValue({ data: [{ payload: response }], error: null });

    await expect(getLatestSentiment()).resolves.toEqual(response);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest spy assertion
    expect(supabase.from).toHaveBeenCalledWith('sentiment_snapshots');
    expect(query.select).toHaveBeenCalledWith('payload');
    expect(query.order).toHaveBeenCalledWith('as_of', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(1);
  });
});
