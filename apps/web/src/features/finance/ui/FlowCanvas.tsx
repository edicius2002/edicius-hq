import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import { useDiagramCamera } from '@/features/finance/hooks/useDiagramCamera';
import { useElementSize } from '@/features/finance/hooks/useElementSize';
import {
  fitCamera,
  IDENTITY_CAMERA,
  centerOn,
  screenToWorld,
  unionRect,
  visibleRect,
  zoomAt,
  WHEEL_STEP,
  ZOOM_STEP,
  type Camera,
  type Rect,
} from '@/features/finance/lib/camera';
import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import {
  anchorPoint,
  contentBounds,
  facingAnchors,
  flowLabelPoint,
  flowPath,
} from '@/features/finance/lib/geometry';
import { formatAmount, formatAssetAmount } from '@/features/finance/lib/format';
import { isFlowActive, selectAccountSummary } from '@/features/finance/lib/summary';
import type {
  Anchor,
  Diagram,
  FinanceNode,
  Flow,
  NodeId,
  Point,
} from '@/features/finance/model/types';

import { CanvasMinimap } from './CanvasMinimap';
import { FlowNode } from './FlowNode';
import styles from './FlowCanvas.module.css';

/** Spacing of the backdrop dots at 100%, so the grid scales with the camera. */
const GRID = 26;

export type Selection = { type: 'node' | 'flow'; id: string } | null;

type FlowCanvasProps = {
  diagram: Diagram;
  selection: Selection;
  /** Anchors are only offered while connecting, so they never block a drag. */
  connectMode: boolean;
  connectFrom: { nodeId: NodeId; anchor: Anchor } | null;
  onSelect: (selection: Selection) => void;
  onMoveNode: (id: NodeId, position: Point) => void;
  onAnchorClick: (nodeId: NodeId, anchor: Anchor) => void;
};

type Drag = {
  nodeId: NodeId;
  pointerId: number;
  /** Where inside the node the pointer grabbed it, so it does not jump. */
  grabOffset: Point;
};

/**
 * A pan in progress. It keeps the camera it started from and applies the whole
 * delta each move, rather than accumulating per-event ones, so a slow drag
 * cannot round its way somewhere the pointer never went.
 */
type Pan = { pointerId: number; origin: Point; from: Camera };

export function FlowCanvas({
  diagram,
  selection,
  connectMode,
  connectFrom,
  onSelect,
  onMoveNode,
  onAnchorClick,
}: FlowCanvasProps) {
  const [viewportRef, viewportSize] = useElementSize<HTMLDivElement>();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const { camera, setCamera } = useDiagramCamera(diagram.id);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pan, setPan] = useState<Pan | null>(null);

  // A switched-off holding keeps its amount but leaves the canvas.
  const nodes = diagram.nodeOrder
    .map((id) => diagram.nodes[id])
    .filter((node) => node && (node.kind !== 'holding' || node.active));
  // Drawing a flow to a node that is not on the canvas would leave an arrow
  // pointing at nothing, so dormant ends hide their flows too.
  const flows = diagram.flowOrder
    .map((id) => diagram.flows[id])
    .filter((flow) => flow && isFlowActive(diagram, flow));

  const bounds = contentBounds(nodes);
  // Node positions are clamped at the origin, so the diagram always starts
  // there and the drawn size is also the region to frame.
  const content: Rect = { left: 0, top: 0, width: bounds.width, height: bounds.height };
  /*
   * The minimap covers the view as well as the diagram. Without that, a view
   * wider than the content puts the frame outside the box and the map shows
   * nothing about where you are; with it, panning away simply grows the map.
   */
  const mapped = unionRect(content, visibleRect(camera, viewportSize));

  /**
   * Ownership is a field on the holding, not an edge, so these tethers are
   * derived at draw time rather than stored — see ADR 0001.
   */
  const ownership = nodes.flatMap((node) => {
    if (node.kind !== 'holding') return [];
    const account = diagram.nodes[node.accountId];
    if (account?.kind !== 'account') return [];
    const anchors = facingAnchors(account, node);
    return [
      {
        id: node.id,
        from: anchorPoint(account, anchors.from),
        to: anchorPoint(node, anchors.to),
        anchors,
      },
    ];
  });

  /** Pointer position in viewport pixels, before the camera is undone. */
  const toViewport = useCallback(
    (event: { clientX: number; clientY: number }): Point => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    },
    [viewportRef],
  );

  /** Where the pointer is in the diagram, whatever the camera is doing. */
  function toWorld(event: PointerEvent): Point {
    return screenToWorld(camera, toViewport(event));
  }

  /*
   * Bound by hand rather than through onWheel: React listens passively, and a
   * passive listener cannot stop the page scrolling out from under the zoom.
   */
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pivot = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setCamera((current) =>
        zoomAt(current, event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, pivot),
      );
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setCamera, viewportRef]);

  function zoomFromCentre(factor: number) {
    setCamera((current) =>
      zoomAt(current, factor, { x: viewportSize.width / 2, y: viewportSize.height / 2 }),
    );
  }

  function startDrag(nodeId: NodeId, event: PointerEvent<HTMLElement>) {
    const node = diagram.nodes[nodeId];
    if (!node) return;
    const pointer = toWorld(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      nodeId,
      pointerId: event.pointerId,
      grabOffset: { x: pointer.x - node.position.x, y: pointer.y - node.position.y },
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    // Only a press on bare canvas pans. Anything else — a node, a flow, the
    // controls, the minimap — is doing its own thing with the pointer.
    const onBackground =
      event.target === event.currentTarget || event.target === surfaceRef.current;
    if (!onBackground) return;

    onSelect(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPan({
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      from: camera,
    });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pan && event.pointerId === pan.pointerId) {
      setCamera({
        ...pan.from,
        x: pan.from.x + (event.clientX - pan.origin.x),
        y: pan.from.y + (event.clientY - pan.origin.y),
      });
      return;
    }

    if (!drag || event.pointerId !== drag.pointerId) return;
    const pointer = toWorld(event);
    onMoveNode(drag.nodeId, {
      x: Math.max(0, Math.round(pointer.x - drag.grabOffset.x)),
      y: Math.max(0, Math.round(pointer.y - drag.grabOffset.y)),
    });
  }

  function endGesture(event: PointerEvent<HTMLDivElement>) {
    if (drag && event.pointerId === drag.pointerId) setDrag(null);
    if (pan && event.pointerId === pan.pointerId) setPan(null);
  }

  return (
    <div
      ref={viewportRef}
      className={`${styles.viewport} ${pan ? styles.panning : ''}`}
      style={{
        // The backdrop travels and scales with the camera; a fixed grid under a
        // moving diagram reads as the canvas standing still.
        backgroundSize: `${GRID * camera.zoom}px ${GRID * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      <div
        ref={surfaceRef}
        className={styles.surface}
        style={{
          width: bounds.width,
          height: bounds.height,
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
        }}
      >
        <svg className={styles.edges} width={bounds.width} height={bounds.height}>
          <defs>
            <marker id="flowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <polygon points="0 0, 8 4, 0 8" fill="rgba(253, 186, 116, 0.9)" />
            </marker>
          </defs>

          {/* Drawn first so real money flows sit on top of the tethers. */}
          {ownership.map((link) => (
            <path
              key={`own-${link.id}`}
              className={styles.ownership}
              d={flowPath(link.from, link.to, link.anchors.from, link.anchors.to)}
            />
          ))}

          {flows.map((flow) => {
            const source = diagram.nodes[flow.from];
            const target = diagram.nodes[flow.to];
            if (!source || !target) return null;

            const from = anchorPoint(source, flow.fromAnchor);
            const to = anchorPoint(target, flow.toAnchor);
            const path = flowPath(from, to, flow.fromAnchor, flow.toAnchor);
            const label = flowLabelPoint(from, to, flow.labelOffset);
            const isSelected = selection?.type === 'flow' && selection.id === flow.id;

            return (
              <g key={flow.id}>
                <path
                  className={styles.edgeHit}
                  d={path}
                  onPointerDown={() => onSelect({ type: 'flow', id: flow.id })}
                />
                <path
                  className={`${styles.edge} ${isSelected ? styles.edgeSelected : ''}`}
                  d={path}
                  markerEnd="url(#flowArrow)"
                  onPointerDown={() => onSelect({ type: 'flow', id: flow.id })}
                />
                {flow.amount !== null && flow.amount > 0 ? (
                  <FlowLabel x={label.x} y={label.y} flow={flow} source={source} target={target} />
                ) : null}
              </g>
            );
          })}
        </svg>

        {nodes.map((node) => (
          <FlowNode
            key={node.id}
            node={node}
            selected={selection?.type === 'node' && selection.id === node.id}
            connecting={connectMode}
            isConnectSource={connectFrom?.nodeId === node.id}
            accountSummary={
              node.kind === 'account' ? selectAccountSummary(diagram, node.id) : undefined
            }
            onSelect={() => onSelect({ type: 'node', id: node.id })}
            onDragStart={(event) => startDrag(node.id, event)}
            onAnchorClick={(anchor) => onAnchorClick(node.id, anchor)}
          />
        ))}
      </div>

      {/* Chrome, not diagram: it sits outside the surface so the camera cannot
          shrink it or push it off screen. */}
      {!nodes.length ? (
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>Nothing here yet</span>
          <span>Add a job or an account to start mapping where money moves.</span>
        </div>
      ) : null}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          aria-label="Zoom out"
          onClick={() => zoomFromCentre(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className={styles.zoomLevel}
          aria-label="Reset zoom to 100%"
          onClick={() => setCamera(IDENTITY_CAMERA)}
        >
          {Math.round(camera.zoom * 100)}%
        </button>
        <button
          type="button"
          className={styles.control}
          aria-label="Zoom in"
          onClick={() => zoomFromCentre(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className={styles.control}
          aria-label="Fit the diagram in view"
          onClick={() => setCamera(fitCamera(content, viewportSize))}
        >
          Fit
        </button>
      </div>

      {nodes.length ? (
        <CanvasMinimap
          nodes={nodes}
          world={mapped}
          camera={camera}
          viewport={viewportSize}
          onMoveTo={(point) => setCamera((current) => centerOn(point, viewportSize, current.zoom))}
        />
      ) : null}
    </div>
  );
}

/**
 * Gross on the first line, and what actually arrives underneath when fees take a
 * cut. The net comes from the same computeTransfer the totals use, so a label can
 * never claim something the summary disagrees with.
 */
function FlowLabel({
  x,
  y,
  flow,
  source,
  target,
}: {
  x: number;
  y: number;
  flow: Flow;
  source: FinanceNode;
  target: FinanceNode;
}) {
  const breakdown = computeTransfer(flow.amount ?? 0, source, target);
  const charged = breakdown.steps.length > 0;
  const overdrawn = isOverdrawnByFees(breakdown);

  return (
    <text className={styles.edgeLabel} x={x} y={y} textAnchor="middle">
      <tspan x={x} dy={charged ? '-0.35em' : '0'}>
        {formatAssetAmount(flow.asset, breakdown.gross)}
      </tspan>
      {charged ? (
        <tspan
          className={overdrawn ? styles.edgeLabelBlocked : styles.edgeLabelNet}
          x={x}
          dy="1.2em"
        >
          {overdrawn ? 'fees exceed it' : `→ ${formatAmount(breakdown.net)}`}
        </tspan>
      ) : null}
    </text>
  );
}
