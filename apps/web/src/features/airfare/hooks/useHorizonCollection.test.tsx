import { describe, expect, it } from 'vitest';

import { airfaresStatusText } from '@/features/airfare/data/collectorStatus';

describe('Airfare horizon collection', () => {
  it('reports only the global collector state and does not invent horizon progress', () => {
    expect(
      airfaresStatusText({
        status: 'running',
        started_at: '2026-09-18T10:00:00Z',
        completed_at: null,
        records_seen: 0,
        records_written: 0,
        records_failed: 0,
        error_code: null,
      }),
    ).not.toMatch(/route|horizon|month/i);
  });
});
