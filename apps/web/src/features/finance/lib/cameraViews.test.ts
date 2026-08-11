import { describe, expect, it } from 'vitest';

import { MAX_ZOOM, MIN_ZOOM } from '@/features/finance/lib/camera';
import {
  NO_FINANCE_CAMERA_VIEWS,
  cameraFor,
  normalizeFinanceCameraViews,
  setFinanceCamera,
} from '@/features/finance/lib/cameraViews';

describe('finance camera views', () => {
  it('starts with no saved cameras when storage is absent or malformed', () => {
    expect(normalizeFinanceCameraViews(undefined)).toEqual(NO_FINANCE_CAMERA_VIEWS);
    expect(normalizeFinanceCameraViews({ cameras: [] })).toEqual(NO_FINANCE_CAMERA_VIEWS);
  });

  it('keeps valid cameras, clamps zoom, and discards broken ones', () => {
    expect(
      normalizeFinanceCameraViews({
        cameras: {
          cash: { x: -340, y: 220, zoom: 99 },
          broken: { x: 'no', y: 20, zoom: 1 },
          backward: { x: 0, y: 0, zoom: 0 },
        },
      }),
    ).toEqual({
      version: 1,
      cameras: {
        cash: { x: -340, y: 220, zoom: MAX_ZOOM },
        backward: { x: 0, y: 0, zoom: MIN_ZOOM },
      },
    });
  });

  it('falls back to 100% and stores a camera per diagram', () => {
    expect(cameraFor(NO_FINANCE_CAMERA_VIEWS, 'new')).toEqual({ x: 0, y: 0, zoom: 1 });

    const saved = setFinanceCamera(NO_FINANCE_CAMERA_VIEWS, 'cash', {
      x: 120,
      y: -44,
      zoom: 1.2,
    });
    expect(cameraFor(saved, 'cash')).toEqual({ x: 120, y: -44, zoom: 1.2 });
    expect(cameraFor(saved, 'other')).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('does not write a duplicate camera', () => {
    const saved = setFinanceCamera(NO_FINANCE_CAMERA_VIEWS, 'cash', { x: 1, y: 2, zoom: 1 });
    expect(setFinanceCamera(saved, 'cash', { x: 1, y: 2, zoom: 1 })).toBe(saved);
  });
});
