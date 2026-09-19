import { describe, expect, it } from 'vitest';

import { airfaresStatusText } from '@/features/airfare/data/collectorStatus';

describe('Airfare collector status', () => {
  it('maps no row, running, complete, and failed collector-wide facts without route attribution', () => {
    expect(airfaresStatusText(null)).toBe('No Airfare run reported yet');
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
    ).toContain('running since');
    expect(
      airfaresStatusText({
        status: 'complete',
        started_at: 'a',
        completed_at: 'b',
        records_seen: 4,
        records_written: 3,
        records_failed: 1,
        error_code: null,
      }),
    ).toContain('4 seen, 3 written, 1 failed');
    expect(
      airfaresStatusText({
        status: 'failed',
        started_at: 'a',
        completed_at: 'b',
        records_seen: 0,
        records_written: 0,
        records_failed: 0,
        error_code: 'provider_refused',
      }),
    ).toContain('provider_refused');
  });
});
