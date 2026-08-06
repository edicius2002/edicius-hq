import { useRef, useState } from 'react';

import { IDENTITY_CAMERA, type Camera } from '@/features/finance/lib/camera';
import type { DiagramId } from '@/features/finance/model/types';

/**
 * One camera per diagram, held in memory rather than stored.
 *
 * Persisting it would cost a storage write per notch of the wheel and per frame
 * of a pan, and where you were last looking is not part of the money — see
 * decision 7.10. Switching tabs swaps cameras instead of carrying one over, for
 * the same reason undo stacks are per diagram: what you do here should land on
 * the diagram in front of you.
 */
export function useDiagramCamera(diagramId: DiagramId) {
  const remembered = useRef(new Map<DiagramId, Camera>());
  const [camera, setCamera] = useState<Camera>(IDENTITY_CAMERA);
  const [shownId, setShownId] = useState(diagramId);

  // Adjusting state during render rather than in an effect, so the first paint
  // of a newly selected diagram already uses its own camera instead of showing
  // the previous one for a frame.
  if (shownId !== diagramId) {
    remembered.current.set(shownId, camera);
    setShownId(diagramId);
    setCamera(remembered.current.get(diagramId) ?? IDENTITY_CAMERA);
  }

  return { camera, setCamera };
}
