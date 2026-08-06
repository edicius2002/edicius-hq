import type { Anchor, FinanceNode, NodeKind, Point } from '@/features/finance/model/types';

export type Size = { width: number; height: number };

/**
 * Node footprints in canvas units. Kept here rather than read from the DOM so
 * flow paths can be computed without a layout pass, and so the money math and
 * the drawing never have to agree on anything but these numbers.
 */
/*
 * Heights fit the most each kind ever shows — four rows, since a holding can add
 * a fee line and an account an operation count. A box that is too short does not
 * overflow: the grid crushes a row instead, which is why these are generous and
 * why .name carries a min-height as a backstop.
 */
export const NODE_SIZE: Record<NodeKind, Size> = {
  job: { width: 200, height: 116 },
  account: { width: 200, height: 116 },
  holding: { width: 140, height: 116 },
};

export function sizeOf(node: FinanceNode): Size {
  return NODE_SIZE[node.kind];
}

/** Fractions of the node box, clockwise from the top-left corner. */
const ANCHOR_FRACTIONS: Record<Anchor, Point> = {
  tl: { x: 0, y: 0 },
  t: { x: 0.5, y: 0 },
  tr: { x: 1, y: 0 },
  r: { x: 1, y: 0.5 },
  br: { x: 1, y: 1 },
  b: { x: 0.5, y: 1 },
  bl: { x: 0, y: 1 },
  l: { x: 0, y: 0.5 },
};

export function anchorPoint(node: FinanceNode, anchor: Anchor): Point {
  const size = sizeOf(node);
  const fraction = ANCHOR_FRACTIONS[anchor];
  return {
    x: node.position.x + size.width * fraction.x,
    y: node.position.y + size.height * fraction.y,
  };
}

export function centerOf(node: FinanceNode): Point {
  const size = sizeOf(node);
  return {
    x: node.position.x + size.width / 2,
    y: node.position.y + size.height / 2,
  };
}

/** Which side an anchor leaves from, so a curve can bulge the right way. */
function horizontalBias(anchor: Anchor): number {
  if (anchor === 'l' || anchor === 'tl' || anchor === 'bl') return -1;
  if (anchor === 'r' || anchor === 'tr' || anchor === 'br') return 1;
  return 0;
}

function verticalBias(anchor: Anchor): number {
  if (anchor === 't' || anchor === 'tl' || anchor === 'tr') return -1;
  if (anchor === 'b' || anchor === 'bl' || anchor === 'br') return 1;
  return 0;
}

/**
 * A cubic curve between two anchors. Control points push out along the side each
 * anchor sits on, which keeps the line clear of its own node instead of cutting
 * back across it.
 */
export function flowPath(from: Point, to: Point, fromAnchor: Anchor, toAnchor: Anchor): string {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const reach = Math.max(40, Math.min(distance * 0.45, 160));

  const c1 = {
    x: from.x + horizontalBias(fromAnchor) * reach,
    y: from.y + verticalBias(fromAnchor) * reach,
  };
  const c2 = {
    x: to.x + horizontalBias(toAnchor) * reach,
    y: to.y + verticalBias(toAnchor) * reach,
  };

  const round = (value: number) => Math.round(value * 10) / 10;
  return `M ${round(from.x)} ${round(from.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(to.x)} ${round(to.y)}`;
}

/** Where a flow's label sits: the curve's rough middle, nudged by any manual offset. */
export function flowLabelPoint(from: Point, to: Point, offset: Point | null): Point {
  return {
    x: (from.x + to.x) / 2 + (offset?.x ?? 0),
    y: (from.y + to.y) / 2 + (offset?.y ?? 0),
  };
}

/**
 * Pick the pair of anchors that face each other, so a connection drawn between
 * two nodes leaves and arrives on the sides that actually point that way.
 */
export function facingAnchors(
  source: FinanceNode,
  target: FinanceNode,
): { from: Anchor; to: Anchor } {
  const a = centerOf(source);
  const b = centerOf(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: 'r', to: 'l' } : { from: 'l', to: 'r' };
  }
  return dy >= 0 ? { from: 'b', to: 't' } : { from: 't', to: 'b' };
}

/** Bounds of everything on the canvas, used to size the scroll area. */
export function contentBounds(
  nodes: FinanceNode[],
  padding = 160,
): { width: number; height: number } {
  let right = 0;
  let bottom = 0;
  for (const node of nodes) {
    const size = sizeOf(node);
    right = Math.max(right, node.position.x + size.width);
    bottom = Math.max(bottom, node.position.y + size.height);
  }
  return { width: right + padding, height: bottom + padding };
}
