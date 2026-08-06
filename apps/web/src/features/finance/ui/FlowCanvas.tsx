import { useCallback, useRef, useState, type PointerEvent } from 'react';

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

import { FlowNode } from './FlowNode';
import styles from './FlowCanvas.module.css';

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

export function FlowCanvas({
  diagram,
  selection,
  connectMode,
  connectFrom,
  onSelect,
  onMoveNode,
  onAnchorClick,
}: FlowCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

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

  /** Pointer position in canvas coordinates, independent of scroll. */
  const toCanvas = useCallback((event: PointerEvent): Point => {
    const surface = surfaceRef.current;
    if (!surface) return { x: 0, y: 0 };
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  function startDrag(nodeId: NodeId, event: PointerEvent<HTMLElement>) {
    const node = diagram.nodes[nodeId];
    if (!node) return;
    const pointer = toCanvas(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      nodeId,
      pointerId: event.pointerId,
      grabOffset: { x: pointer.x - node.position.x, y: pointer.y - node.position.y },
    });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const pointer = toCanvas(event);
    onMoveNode(drag.nodeId, {
      x: Math.max(0, Math.round(pointer.x - drag.grabOffset.x)),
      y: Math.max(0, Math.round(pointer.y - drag.grabOffset.y)),
    });
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag && event.pointerId === drag.pointerId) setDrag(null);
  }

  return (
    <div
      className={styles.viewport}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={(event) => {
        // A press on empty canvas clears the selection.
        if (event.target === event.currentTarget || event.target === surfaceRef.current) {
          onSelect(null);
        }
      }}
    >
      <div
        ref={surfaceRef}
        className={styles.surface}
        style={{ width: bounds.width, height: bounds.height }}
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

        {!nodes.length ? (
          <div className={styles.empty}>
            <span className={styles.emptyTitle}>Nothing here yet</span>
            <span>Add a job or an account to start mapping where money moves.</span>
          </div>
        ) : null}
      </div>
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
