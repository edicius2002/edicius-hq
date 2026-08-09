import { sizeOf, type NodeContent } from '@/features/finance/lib/geometry';
import { selectNodeContent } from '@/features/finance/lib/summary';
import type {
  Diagram,
  FinanceNode,
  Frame,
  FrameId,
  Point,
  Rect,
  Size,
} from '@/features/finance/model/types';

/** Small enough to ring a single node, large enough to still read as a region. */
export const FRAME_MIN_SIZE: Size = { width: 180, height: 150 };

export function frameRect(frame: Frame): Rect {
  return {
    left: frame.position.x,
    top: frame.position.y,
    width: frame.size.width,
    height: frame.size.height,
  };
}

/**
 * A node's footprint.
 *
 * `content` is not optional in spirit: a height now follows the rows a node
 * shows, so measuring one without it gives the shortest box that kind can be,
 * and a frame would decide ownership on a rectangle nobody can see. Callers
 * that have the diagram pass `selectNodeContent`.
 */
export function nodeRect(node: FinanceNode, content?: NodeContent): Rect {
  const size = sizeOf(node, content);
  return { left: node.position.x, top: node.position.y, width: size.width, height: size.height };
}

/** Whether `inner` sits entirely within `outer`. Touching edges count as inside. */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

/** The rectangle between two corners, whichever way round they were dragged. */
export function rectBetween(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function listFrames(diagram: Diagram): Frame[] {
  return diagram.frameOrder.map((id) => diagram.frames[id]).filter(Boolean);
}

/** A switched-off holding leaves the canvas, so no frame can be around it. */
function isPlaced(node: FinanceNode): boolean {
  return node.kind !== 'holding' || node.active;
}

export function listPlacedNodes(diagram: Diagram): FinanceNode[] {
  return diagram.nodeOrder.map((id) => diagram.nodes[id]).filter((node) => node && isPlaced(node));
}

/**
 * Which frame a node belongs to: the smallest that fully contains it, and on an
 * equal area the one added later.
 *
 * Derived from the geometry every time rather than recorded when the frame was
 * drawn. Dragging a node into a frame is then all it takes to join it, and there
 * is no second copy of the truth to fall out of step — the same call ADR 0001
 * made for holding ownership.
 */
export function ownerFrameOf(diagram: Diagram, node: FinanceNode): FrameId | null {
  if (!isPlaced(node)) return null;

  // Measured the way the canvas draws it. Before heights followed content this
  // was one number per kind and the two could not disagree; now they can, and a
  // frame deciding ownership on a box nobody can see would be the worst kind of
  // bug — invisible and about position.
  const bounds = nodeRect(node, selectNodeContent(diagram, node));
  let owner: FrameId | null = null;
  let ownerArea = Number.POSITIVE_INFINITY;

  for (const frame of listFrames(diagram)) {
    const rect = frameRect(frame);
    if (!contains(rect, bounds)) continue;

    // `<=` rather than `<`: later frames come later in the order, so an equal
    // area hands the node to the newer one.
    const area = rect.width * rect.height;
    if (area <= ownerArea) {
      owner = frame.id;
      ownerArea = area;
    }
  }

  return owner;
}

export function frameMembers(diagram: Diagram, frameId: FrameId): FinanceNode[] {
  return listPlacedNodes(diagram).filter((node) => ownerFrameOf(diagram, node) === frameId);
}

/** Every frame's members in one pass, for when the whole canvas is being drawn. */
export function frameMembership(diagram: Diagram): Map<FrameId, FinanceNode[]> {
  const byFrame = new Map<FrameId, FinanceNode[]>(diagram.frameOrder.map((id) => [id, []]));

  for (const node of listPlacedNodes(diagram)) {
    const owner = ownerFrameOf(diagram, node);
    if (owner) byFrame.get(owner)?.push(node);
  }

  return byFrame;
}

/** The eight directions a frame can be pulled from. */
export const RESIZE_EDGES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

export type ResizeEdge = (typeof RESIZE_EDGES)[number];

/**
 * Pull one edge or corner by a delta. Only the sides named in the edge move, so
 * dragging the west side leaves the east one exactly where it was, and a
 * rectangle squeezed to its minimum stops shrinking rather than turning inside
 * out.
 */
export function resizeRect(
  rect: Rect,
  edge: ResizeEdge,
  delta: Point,
  min: Size = FRAME_MIN_SIZE,
): Rect {
  let { left, top, width, height } = rect;

  if (edge.includes('e')) width = Math.max(min.width, rect.width + delta.x);
  if (edge.includes('w')) {
    width = Math.max(min.width, rect.width - delta.x);
    left = rect.left + rect.width - width;
  }

  if (edge.includes('s')) height = Math.max(min.height, rect.height + delta.y);
  if (edge.includes('n')) {
    height = Math.max(min.height, rect.height - delta.y);
    top = rect.top + rect.height - height;
  }

  return { left, top, width, height };
}
