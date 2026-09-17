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
import {
  useRemoteDocument,
  type RemoteStoredDocument,
} from '@/features/finance/hooks/useRemoteDocument';

/** The remote lifecycle that the canvas reports to the Finance page. */
export type DiagramCameraPersistence = Pick<
  RemoteStoredDocument<FinanceCameraViews>,
  | 'isError'
  | 'saveState'
  | 'retrySave'
  | 'conflict'
  | 'refreshConflict'
  | 'acceptRemote'
  | 'overwriteRemote'
> & {
  /** Includes the local restoration paint as well as the remote fetch. */
  isFetching: boolean;
};

/**
 * One camera per diagram, restored independently from the financial document.
 *
 * The view still does not become money data. The shared write queue coalesces
 * a pan or wheel run to one durable write, while local state keeps the canvas
 * at the pointer rather than waiting for storage.
 */
export function useDiagramCamera(diagramId: DiagramId) {
  const store = useRemoteDocument<FinanceCameraViews>({
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

  const isFetching = store.isFetching || !hydrated;

  const updateCamera = useCallback(
    (nextOrChange: SetStateAction<Camera>) => {
      // The page makes this unavailable to people, and this guard gives the
      // same protection to an in-flight native gesture. A placeholder or a
      // conflicted local view must never be queued as a new remote edit.
      if (isFetching || store.isError || store.conflict) return;

      setCamera((current) => {
        const next = typeof nextOrChange === 'function' ? nextOrChange(current) : nextOrChange;
        if (next === current) return current;

        setRemembered((prev) => new Map(prev).set(diagramId, next));
        void store.edit((views) => setFinanceCamera(views, diagramId, next));
        return next;
      });
    },
    [diagramId, isFetching, store],
  );

  const acceptRemote = useCallback(() => {
    const conflict = store.conflict;
    if (conflict?.status === 'ready') {
      const accepted = conflict.remote;
      const restored = cameraFor(accepted, diagramId);
      // Every remembered tab belongs to the accepted whole document. Leaving
      // an old tab in the map would resurrect the discarded local conflict on
      // the next diagram switch.
      setRemembered((current) => {
        const next = new Map(current);
        for (const id of next.keys()) next.set(id, cameraFor(accepted, id));
        next.set(diagramId, restored);
        return next;
      });
      setCamera(restored);
    }
    store.acceptRemote();
  }, [diagramId, store]);

  return {
    camera,
    setCamera: updateCamera,
    isFetching,
    isError: store.isError,
    saveState: store.saveState,
    retrySave: store.retrySave,
    conflict: store.conflict,
    refreshConflict: store.refreshConflict,
    acceptRemote,
    overwriteRemote: store.overwriteRemote,
  };
}
