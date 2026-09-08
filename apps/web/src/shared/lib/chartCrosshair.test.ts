import { describe, expect, it } from 'vitest';

import { nearestPointIndex, pointerInView } from '@/shared/lib/chartCrosshair';

describe('pointerInView', () => {
  const view = { width: 760, height: 338 };

  it('keeps client and drawing coordinates aligned at the same aspect ratio', () => {
    expect(pointerInView({ left: 10, top: 20, width: 1520, height: 676 }, view, 834, 400)).toEqual({
      x: 412,
      y: 190,
    });
  });

  it('subtracts pillarbox bars before converting the pointer', () => {
    const box = { left: 0, top: 0, width: 1099.2, height: 465.44 };
    const scale = box.height / view.height;
    const pad = (box.width - view.width * scale) / 2;

    expect(pointerInView(box, view, pad + 76 * scale, 0)?.x).toBeCloseTo(76, 6);
  });

  it('subtracts letterbox bars before converting the pointer', () => {
    const box = { left: 0, top: 0, width: 700, height: 420 };
    const scale = box.width / view.width;
    const pad = (box.height - view.height * scale) / 2;

    expect(pointerInView(box, view, 0, pad + 266 * scale)?.y).toBeCloseTo(266, 6);
  });

  it('refuses a box with no drawable area', () => {
    expect(pointerInView({ left: 0, top: 0, width: 0, height: 338 }, view, 10, 10)).toBeNull();
  });
});

describe('nearestPointIndex', () => {
  const points = [
    { timestamp: '2026-01-01T00:00:00Z' },
    { timestamp: '2026-01-03T00:00:00Z' },
    { timestamp: '2026-01-10T00:00:00Z' },
  ];

  it('selects the closest observed timestamp instead of inventing a day', () => {
    expect(nearestPointIndex(points, '2026-01-08T00:00:00Z')).toBe(2);
  });

  it('keeps the earlier observation on an exact tie', () => {
    expect(nearestPointIndex(points, '2026-01-02T00:00:00Z')).toBe(0);
  });

  it('clamps outside the observed range and has no answer for an empty series', () => {
    expect(nearestPointIndex(points, '2025-01-01T00:00:00Z')).toBe(0);
    expect(nearestPointIndex(points, '2027-01-01T00:00:00Z')).toBe(2);
    expect(nearestPointIndex([], '2026-01-01T00:00:00Z')).toBeNull();
  });
});
