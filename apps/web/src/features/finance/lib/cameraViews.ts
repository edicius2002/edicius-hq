import { clampZoom, IDENTITY_CAMERA, type Camera } from '@/features/finance/lib/camera';
import type { DiagramId } from '@/features/finance/model/types';
import type { StorageKey } from '@/shared/storage/keys';

/** View state stays apart from the financial document and its backups. */
export const FINANCE_CAMERA_VIEWS_KEY: StorageKey = 'finance-camera-views';

export type FinanceCameraViews = {
  version: 1;
  cameras: Record<DiagramId, Camera>;
};

export const NO_FINANCE_CAMERA_VIEWS: FinanceCameraViews = { version: 1, cameras: {} };

function toCamera(value: unknown): Camera | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof zoom !== 'number' ||
    !Number.isFinite(zoom)
  ) {
    return null;
  }
  return { x, y, zoom: clampZoom(zoom) };
}

/** Invalid view state never stops Finance from opening. */
export function normalizeFinanceCameraViews(value: unknown): FinanceCameraViews {
  if (!value || typeof value !== 'object') return NO_FINANCE_CAMERA_VIEWS;
  const raw = (value as { cameras?: unknown }).cameras;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_FINANCE_CAMERA_VIEWS;

  const cameras: Record<DiagramId, Camera> = {};
  for (const [diagramId, value] of Object.entries(raw)) {
    const camera = toCamera(value);
    if (diagramId && camera) cameras[diagramId] = camera;
  }
  return { version: 1, cameras };
}

export function cameraFor(views: FinanceCameraViews, diagramId: DiagramId): Camera {
  return views.cameras[diagramId] ?? IDENTITY_CAMERA;
}

/** Repeated pointer frames at a pan or zoom limit do not make a new document. */
export function setFinanceCamera(
  views: FinanceCameraViews,
  diagramId: DiagramId,
  camera: Camera,
): FinanceCameraViews {
  const previous = views.cameras[diagramId];
  if (previous?.x === camera.x && previous.y === camera.y && previous.zoom === camera.zoom) {
    return views;
  }
  return { version: 1, cameras: { ...views.cameras, [diagramId]: camera } };
}
