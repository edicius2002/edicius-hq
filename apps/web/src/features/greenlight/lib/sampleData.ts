import type { GreenlightState } from '@/features/greenlight/model/types';

/** Synthetic sample matching legacy Greenlight demo Fridays. */
export function createSampleGreenlightState(now = new Date()): GreenlightState {
  const stats = {
    '2026-05-01': {
      Deliverable: {
        amount: 420,
        tasks: 18,
        attempter: 18,
        reviewer: 0,
        details: ['Total Delivered Tasks: 18'],
      },
      currency: 'USD',
    },
    '2026-05-08': {
      Deliverable: {
        amount: 560,
        tasks: 24,
        attempter: 16,
        reviewer: 8,
        details: ['Attempter: 16; Reviewer: 8'],
      },
      currency: 'USD',
    },
    '2026-05-15': {
      Deliverable: {
        amount: 610,
        tasks: 27,
        attempter: 27,
        reviewer: 0,
        details: ['Total Delivered Tasks: 27'],
      },
      currency: 'USD',
    },
  };

  return {
    stats,
    markers: [],
    meta: {
      fileName: 'sample-data',
      rowsRead: 3,
      daysGenerated: Object.keys(stats).length,
      replaceMode: 'all',
      updatedAt: now.toISOString(),
      statusTitle: 'Sample loaded',
      statusDetail: 'Sample data loaded so you can review the dashboard.',
    },
  };
}
