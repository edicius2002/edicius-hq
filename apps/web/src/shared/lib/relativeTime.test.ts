import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '@/shared/lib/relativeTime';

describe('formatRelativeTime', () => {
  it('uses the largest completed unit so a recent update stays easy to scan', () => {
    expect(
      formatRelativeTime('2026-08-31T12:00:00.000Z', new Date('2026-08-31T12:03:20.000Z')),
    ).toBe('3 minutes ago');
  });

  it('returns no label for a corrupt timestamp instead of breaking the page', () => {
    expect(formatRelativeTime('not-a-date', new Date('2026-08-31T12:03:20.000Z'))).toBeNull();
  });
});
