import { useRef, type PointerEvent } from 'react';

import {
  minimapToWorld,
  minimapView,
  visibleRect,
  worldToMinimap,
  type Camera,
  type Rect,
} from '@/features/finance/lib/camera';
import { sizeOf, type Size } from '@/features/finance/lib/geometry';
import type { FinanceNode, Frame, Point } from '@/features/finance/model/types';

import styles from './CanvasMinimap.module.css';

/**
 * Fixed rather than measured: the drawing maths needs a box size, and a constant
 * spares the minimap its own resize observer. Mirrored in the stylesheet.
 */
const BOX: Size = { width: 168, height: 112 };
const PADDING = 8;

/** Under this a node reads as a dot, but it is still on the map. */
const MIN_NODE = 3;

const KIND_CLASS: Record<FinanceNode['kind'], string> = {
  job: styles.job,
  account: styles.account,
  holding: styles.holding,
};

type CanvasMinimapProps = {
  nodes: FinanceNode[];
  frames: Frame[];
  /** The whole diagram, which the minimap always shows in full. */
  world: Rect;
  camera: Camera;
  viewport: Size;
  onMoveTo: (world: Point) => void;
};

/**
 * The diagram at a glance, with the visible area marked. It reads the same
 * bounds and the same camera the canvas does, so the rectangle cannot claim a
 * view the canvas is not showing.
 */
export function CanvasMinimap({
  nodes,
  frames,
  world,
  camera,
  viewport,
  onMoveTo,
}: CanvasMinimapProps) {
  const dragPointer = useRef<number | null>(null);
  const view = minimapView(world, BOX, PADDING);

  // Before the first measurement there is no viewport to mark, so the frame is
  // left off rather than drawn as a sliver in the corner.
  const measured = viewport.width > 0 && viewport.height > 0;
  const visible = visibleRect(camera, viewport);
  const frame = worldToMinimap(view, { x: visible.left, y: visible.top });

  function moveTo(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    onMoveTo(minimapToWorld(view, { x: event.clientX - rect.left, y: event.clientY - rect.top }));
  }

  return (
    <svg
      className={styles.minimap}
      width={BOX.width}
      height={BOX.height}
      viewBox={`0 0 ${BOX.width} ${BOX.height}`}
      role="img"
      aria-label="Diagram minimap"
      onPointerDown={(event) => {
        // Never let a press here reach the canvas underneath, or moving the view
        // would also start a pan and clear the selection.
        event.stopPropagation();
        event.preventDefault();
        dragPointer.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        moveTo(event);
      }}
      onPointerMove={(event) => {
        if (dragPointer.current !== event.pointerId) return;
        moveTo(event);
      }}
      onPointerUp={(event) => {
        if (dragPointer.current === event.pointerId) dragPointer.current = null;
      }}
      onPointerCancel={() => {
        dragPointer.current = null;
      }}
    >
      {/* Under the nodes here too, so the map reads the way the canvas does. */}
      {frames.map((frame) => {
        const at = worldToMinimap(view, frame.position);
        return (
          <rect
            key={frame.id}
            className={styles.frame}
            x={at.x}
            y={at.y}
            width={Math.max(MIN_NODE, frame.size.width * view.scale)}
            height={Math.max(MIN_NODE, frame.size.height * view.scale)}
            rx={2}
          />
        );
      })}

      {nodes.map((node) => {
        const size = sizeOf(node);
        const at = worldToMinimap(view, node.position);
        return (
          <rect
            key={node.id}
            className={KIND_CLASS[node.kind]}
            x={at.x}
            y={at.y}
            width={Math.max(MIN_NODE, size.width * view.scale)}
            height={Math.max(MIN_NODE, size.height * view.scale)}
            rx={1}
          />
        );
      })}

      {measured ? (
        <rect
          className={styles.frame}
          x={frame.x}
          y={frame.y}
          width={Math.max(MIN_NODE, visible.width * view.scale)}
          height={Math.max(MIN_NODE, visible.height * view.scale)}
          rx={2}
        />
      ) : null}
    </svg>
  );
}
