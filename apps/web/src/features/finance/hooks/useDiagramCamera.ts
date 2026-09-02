import { useCallback, useState, type SetStateAction } from 'react';

import { IDENTITY_CAMERA, type Camera } from '@/features/finance/lib/camera';
import {
  FINANCE_CAMERA_VIEWS_KEY,
  NO_FINANCE_CAMERA_VIEWS,
  cameraFor,
  normalizeFinanceCameraViews,
  setFinanceCamera,
  type FinanceCameraViews,
} from '@/features/finance/lib/cameraViews';
import type { DiagramId } from '@/features/finance/model/types';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * One camera per diagram, restored independently from the financial document.
 *
 * The view still does not become money data or backup content. The shared write
 * queue coalesces a pan or wheel run to one durable write, while local state
 * keeps the canvas at the pointer rather than waiting for storage.
 */
export function useDiagramCamera(diagramId: DiagramId) {
  const store = useStoredDocument<FinanceCameraViews>({
    key: FINANCE_CAMERA_VIEWS_KEY,
    normalize: normalizeFinanceCameraViews,
    placeholder: NO_FINANCE_CAMERA_VIEWS,
  });
  // A camera-per-diagram cache. Kept as state rather than a ref because it is
  // both read and written while computing this render's camera, not just from
  // callbacks.
  const [remembered, setRemembered] = useState(() => new Map<DiagramId, Camera>());
  const [camera, setCamera] = useState<Camera>(IDENTITY_CAMERA);
  const [shownId, setShownId] = useState(diagramId);
  const [hydrated, setHydrated] = useState(false);

  // The storage read is deliberately folded into render, like a tab switch: the
  // first usable paint has the restored view rather than briefly showing 100%.
  if (!store.isFetching && !hydrated) {
    const restored = cameraFor(store.data, diagramId);
    setRemembered((current) => new Map(current).set(diagramId, restored));
    setCamera(restored);
    setHydrated(true);
  }

  // Switching tabs swaps cameras rather than carrying one across. An in-memory
  // map covers the instant switch; the stored map covers leaving and returning.
  if (shownId !== diagramId) {
    setRemembered((current) => new Map(current).set(shownId, camera));
    setShownId(diagramId);
    setCamera(remembered.get(diagramId) ?? cameraFor(store.data, diagramId));
  }

  const updateCamera = useCallback(
    (nextOrChange: SetStateAction<Camera>) => {
      setCamera((current) => {
        const next = typeof nextOrChange === 'function' ? nextOrChange(current) : nextOrChange;
        if (next === current) return current;

        setRemembered((prev) => new Map(prev).set(diagramId, next));
        void store.edit((views) => setFinanceCamera(views, diagramId, next));
        return next;
      });
    },
    [diagramId, store],
  );

  return { camera, setCamera: updateCamera, isFetching: store.isFetching || !hydrated };
}
