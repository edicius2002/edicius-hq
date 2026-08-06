import { describe, expect, it } from 'vitest';

import {
  centerOn,
  clampZoom,
  fitCamera,
  IDENTITY_CAMERA,
  MAX_ZOOM,
  MIN_ZOOM,
  minimapToWorld,
  minimapView,
  panBy,
  screenToWorld,
  unionRect,
  visibleRect,
  worldToMinimap,
  worldToScreen,
  zoomAt,
  type Camera,
} from '@/features/finance/lib/camera';

const VIEWPORT = { width: 800, height: 600 };

function closeTo(point: { x: number; y: number }, x: number, y: number) {
  expect(point.x).toBeCloseTo(x, 6);
  expect(point.y).toBeCloseTo(y, 6);
}

describe('clampZoom', () => {
  it('holds the range', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it('falls back to 100% for a number that is not one', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe('screenToWorld', () => {
  const camera: Camera = { x: -120, y: 40, zoom: 1.5 };

  it('undoes worldToScreen', () => {
    const world = { x: 317, y: -84 };
    closeTo(screenToWorld(camera, worldToScreen(camera, world)), world.x, world.y);
  });

  it('is the identity when the camera is', () => {
    closeTo(screenToWorld(IDENTITY_CAMERA, { x: 12, y: 34 }), 12, 34);
  });

  it('accounts for the zoom, not just the pan', () => {
    // Halving the zoom doubles the world distance a pixel covers.
    closeTo(screenToWorld({ x: 0, y: 0, zoom: 0.5 }, { x: 100, y: 50 }), 200, 100);
  });
});

describe('zoomAt', () => {
  it('leaves the point under the pivot where it was', () => {
    const camera: Camera = { x: 30, y: -70, zoom: 0.8 };
    const pivot = { x: 512, y: 288 };
    const before = screenToWorld(camera, pivot);

    const zoomed = zoomAt(camera, 1.6, pivot);
    closeTo(worldToScreen(zoomed, before), pivot.x, pivot.y);
  });

  it('survives a run of steps without drifting off the pivot', () => {
    const pivot = { x: 200, y: 150 };
    let camera: Camera = IDENTITY_CAMERA;
    const target = screenToWorld(camera, pivot);

    for (let step = 0; step < 8; step += 1) camera = zoomAt(camera, 1.1, pivot);
    closeTo(worldToScreen(camera, target), pivot.x, pivot.y);
  });

  it('clamps, and hands back the same camera once there is nowhere to go', () => {
    const camera = zoomAt(IDENTITY_CAMERA, 100, { x: 0, y: 0 });
    expect(camera.zoom).toBe(MAX_ZOOM);
    expect(zoomAt(camera, 2, { x: 0, y: 0 })).toBe(camera);
  });
});

describe('panBy', () => {
  it('shifts the camera and leaves the zoom alone', () => {
    expect(panBy({ x: 10, y: 20, zoom: 2 }, { x: -4, y: 6 })).toEqual({ x: 6, y: 26, zoom: 2 });
  });
});

describe('visibleRect', () => {
  it('matches the corners the pointer maths would report', () => {
    const camera: Camera = { x: -200, y: 100, zoom: 1.25 };
    const rect = visibleRect(camera, VIEWPORT);
    const topLeft = screenToWorld(camera, { x: 0, y: 0 });
    const bottomRight = screenToWorld(camera, { x: VIEWPORT.width, y: VIEWPORT.height });

    closeTo({ x: rect.left, y: rect.top }, topLeft.x, topLeft.y);
    closeTo({ x: rect.left + rect.width, y: rect.top + rect.height }, bottomRight.x, bottomRight.y);
  });

  it('shows more world as the camera zooms out', () => {
    expect(visibleRect({ x: 0, y: 0, zoom: 0.5 }, VIEWPORT).width).toBe(VIEWPORT.width * 2);
  });
});

describe('unionRect', () => {
  it('covers both', () => {
    expect(
      unionRect(
        { left: 0, top: 0, width: 100, height: 100 },
        { left: -50, top: 40, width: 80, height: 200 },
      ),
    ).toEqual({ left: -50, top: 0, width: 150, height: 240 });
  });

  it('changes nothing when one already contains the other', () => {
    const outer = { left: 0, top: 0, width: 500, height: 500 };
    expect(unionRect(outer, { left: 100, top: 100, width: 50, height: 50 })).toEqual(outer);
  });
});

describe('centerOn', () => {
  it('puts the point in the middle', () => {
    const camera = centerOn({ x: 400, y: 900 }, VIEWPORT, 0.5);
    closeTo(worldToScreen(camera, { x: 400, y: 900 }), VIEWPORT.width / 2, VIEWPORT.height / 2);
  });
});

describe('fitCamera', () => {
  it('brings a diagram larger than the viewport fully into view', () => {
    const bounds = { left: 0, top: 0, width: 2400, height: 1200 };
    const camera = fitCamera(bounds, VIEWPORT);
    const visible = visibleRect(camera, VIEWPORT);

    expect(visible.left).toBeLessThanOrEqual(bounds.left + 0.001);
    expect(visible.top).toBeLessThanOrEqual(bounds.top + 0.001);
    expect(visible.left + visible.width).toBeGreaterThanOrEqual(bounds.left + bounds.width - 0.001);
    expect(visible.top + visible.height).toBeGreaterThanOrEqual(bounds.top + bounds.height - 0.001);
  });

  it('centres what it frames', () => {
    const camera = fitCamera({ left: 100, top: 100, width: 1600, height: 1600 }, VIEWPORT);
    closeTo(worldToScreen(camera, { x: 900, y: 900 }), VIEWPORT.width / 2, VIEWPORT.height / 2);
  });

  it('never zooms past 100% for a diagram that already fits', () => {
    expect(fitCamera({ left: 0, top: 0, width: 200, height: 150 }, VIEWPORT).zoom).toBe(1);
  });

  it('stays put when there is nothing to frame or nowhere to frame it', () => {
    expect(fitCamera({ left: 0, top: 0, width: 0, height: 0 }, VIEWPORT)).toEqual(IDENTITY_CAMERA);
    expect(
      fitCamera({ left: 0, top: 0, width: 500, height: 500 }, { width: 0, height: 0 }),
    ).toEqual(IDENTITY_CAMERA);
  });
});

describe('minimapView', () => {
  const box = { width: 168, height: 112 };

  it('fits the whole diagram inside the box', () => {
    const bounds = { left: 0, top: 0, width: 3000, height: 400 };
    const view = minimapView(bounds, box, 8);

    const topLeft = worldToMinimap(view, { x: bounds.left, y: bounds.top });
    const bottomRight = worldToMinimap(view, {
      x: bounds.left + bounds.width,
      y: bounds.top + bounds.height,
    });

    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
    expect(bottomRight.x).toBeLessThanOrEqual(box.width);
    expect(bottomRight.y).toBeLessThanOrEqual(box.height);
  });

  it('centres the diagram in the box', () => {
    const bounds = { left: 0, top: 0, width: 3000, height: 400 };
    const view = minimapView(bounds, box, 8);
    const middle = worldToMinimap(view, { x: 1500, y: 200 });

    closeTo(middle, box.width / 2, box.height / 2);
  });

  it('reads back the world point it drew', () => {
    const view = minimapView({ left: -300, top: 50, width: 1200, height: 800 }, box, 8);
    const world = { x: 240, y: 610 };
    closeTo(minimapToWorld(view, worldToMinimap(view, world)), world.x, world.y);
  });

  it('does not divide by zero on an empty diagram', () => {
    const view = minimapView({ left: 0, top: 0, width: 0, height: 0 }, box, 8);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(view.scale).toBeGreaterThan(0);
  });
});
