import type { Size } from '@/features/finance/lib/geometry';
import type { Point } from '@/features/finance/model/types';

/**
 * Where the canvas is looking. `x` and `y` translate the world in viewport
 * pixels, `zoom` scales it, applied in that order — the same
 * `translate() scale()` the surface carries.
 *
 * Everything that has to agree about what is on screen goes through this file:
 * the transform on the content, the pointer maths behind every drag and anchor
 * click, and the rectangle the minimap draws. One camera read three ways rather
 * than three answers to the same question.
 *
 * It is deliberately not part of the stored document — see decision 7.10.
 */
export type Camera = { x: number; y: number; zoom: number };

/** A region of the world: where it starts and how far it runs. */
export type Rect = { left: number; top: number; width: number; height: number };

export const IDENTITY_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

/** One button press. The wheel steps finer because it fires far more often. */
export const ZOOM_STEP = 1.2;
export const WHEEL_STEP = 1.1;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Viewport pixels to world units. Every pointer position starts here. */
export function screenToWorld(camera: Camera, point: Point): Point {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

export function worldToScreen(camera: Camera, point: Point): Point {
  return {
    x: point.x * camera.zoom + camera.x,
    y: point.y * camera.zoom + camera.y,
  };
}

/**
 * Zoom about a fixed point of the viewport: whatever sits under `pivot` is still
 * under it afterwards. Scaling without this slides the diagram away from the
 * cursor, so you chase what you were trying to look at.
 */
export function zoomAt(camera: Camera, factor: number, pivot: Point): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  // At either limit there is nothing to do, and the identity keeps the caller
  // from re-rendering on every further notch of the wheel.
  if (zoom === camera.zoom) return camera;

  const ratio = zoom / camera.zoom;
  return {
    zoom,
    x: pivot.x - (pivot.x - camera.x) * ratio,
    y: pivot.y - (pivot.y - camera.y) * ratio,
  };
}

/** Move the camera by a screen-space delta, which is what a drag produces. */
export function panBy(camera: Camera, delta: Point): Camera {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

/** What the viewport currently shows, in world units. */
export function visibleRect(camera: Camera, viewport: Size): Rect {
  return {
    left: -camera.x / camera.zoom,
    top: -camera.y / camera.zoom,
    width: viewport.width / camera.zoom,
    height: viewport.height / camera.zoom,
  };
}

/** The smallest region covering both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: right - left, height: bottom - top };
}

/** Put a world point in the middle of the viewport, keeping the current zoom. */
export function centerOn(point: Point, viewport: Size, zoom: number): Camera {
  return {
    zoom,
    x: viewport.width / 2 - point.x * zoom,
    y: viewport.height / 2 - point.y * zoom,
  };
}

/**
 * Frame a region in the viewport. Never zooms past 100%: a diagram of two nodes
 * blown up to fill the screen reads as a bug rather than as a fit.
 */
export function fitCamera(bounds: Rect, viewport: Size): Camera {
  if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return IDENTITY_CAMERA;
  }

  const zoom = clampZoom(
    Math.min(1, viewport.width / bounds.width, viewport.height / bounds.height),
  );
  return centerOn(
    { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
    viewport,
    zoom,
  );
}

/**
 * How the whole diagram is squeezed into the minimap box. Separate from the
 * camera: the minimap always shows everything, whatever the camera is doing.
 */
export type MinimapView = { scale: number; offsetX: number; offsetY: number };

export function minimapView(bounds: Rect, size: Size, padding: number): MinimapView {
  const usableWidth = Math.max(1, size.width - padding * 2);
  const usableHeight = Math.max(1, size.height - padding * 2);
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const scale = Math.max(0.0001, Math.min(usableWidth / width, usableHeight / height));

  return {
    scale,
    offsetX: (size.width - bounds.width * scale) / 2 - bounds.left * scale,
    offsetY: (size.height - bounds.height * scale) / 2 - bounds.top * scale,
  };
}

export function worldToMinimap(view: MinimapView, point: Point): Point {
  return { x: point.x * view.scale + view.offsetX, y: point.y * view.scale + view.offsetY };
}

export function minimapToWorld(view: MinimapView, point: Point): Point {
  return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale };
}
