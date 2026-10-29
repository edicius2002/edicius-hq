import { screenToWorld, visibleRect, type Camera } from '@/features/finance/lib/camera';
import { listPlacedNodes, nodeRect } from '@/features/finance/lib/frames';
import {
  anchorPoint,
  facingAnchors,
  flowCurve,
  flowLabelPoint,
  sizeOf,
} from '@/features/finance/lib/geometry';
import { isFlowActive, selectNodeContent } from '@/features/finance/lib/summary';
import type { Diagram, FinanceNode, Point, Rect, Size } from '@/features/finance/model/types';

export type PlacementView = { camera: Camera; viewport: Size };

const GAP = 16;
const STEP = 20;

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

function padded(rect: Rect): Rect {
  return {
    left: rect.left - GAP,
    top: rect.top - GAP,
    width: rect.width + GAP * 2,
    height: rect.height + GAP * 2,
  };
}

function inside(outer: Rect, inner: Rect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

/** The same cubic that FlowCanvas renders, sampled densely enough for a padded box. */
function curvePoints(
  from: Point,
  to: Point,
  fromAnchor: Parameters<typeof flowCurve>[2],
  toAnchor: Parameters<typeof flowCurve>[3],
): Point[] {
  const curve = flowCurve(from, to, fromAnchor, toAnchor);
  return Array.from({ length: 33 }, (_, index) => {
    const t = index / 32;
    const u = 1 - t;
    return {
      x:
        u ** 3 * curve.from.x +
        3 * u ** 2 * t * curve.c1.x +
        3 * u * t ** 2 * curve.c2.x +
        t ** 3 * curve.to.x,
      y:
        u ** 3 * curve.from.y +
        3 * u ** 2 * t * curve.c1.y +
        3 * u * t ** 2 * curve.c2.y +
        t ** 3 * curve.to.y,
    };
  });
}

/** True when one segment enters a rectangle, including its boundary. */
function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  const edges = [
    [-dx, a.x - rect.left],
    [dx, rect.left + rect.width - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.top + rect.height - a.y],
  ];
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const t = distance / direction;
    if (direction < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  return true;
}

type Offset = { x: number; y: number; distance: number };

/** A small priority queue visits candidate centers in actual distance order. */
class CandidateQueue {
  private heap: Offset[] = [];

  push(x: number, y: number) {
    const item = { x, y, distance: x * x + y * y };
    let index = this.heap.length;
    this.heap.push(item);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].distance <= item.distance) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = item;
  }

  pop(): Offset | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!first || !last || this.heap.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.heap.length &&
        this.heap[child + 1].distance < this.heap[child].distance
      ) {
        child++;
      }
      if (last.distance <= this.heap[child].distance) break;
      this.heap[index] = this.heap[child];
      index = child;
    }
    this.heap[index] = last;
    return first;
  }

  get length() {
    return this.heap.length;
  }
}

/** Find the closest free footprint to the center of the camera's current view. */
export function placeNewNode(
  diagram: Diagram,
  kind: 'job' | 'account',
  { camera, viewport }: PlacementView,
): Point {
  const center = screenToWorld(camera, { x: viewport.width / 2, y: viewport.height / 2 });
  const view = visibleRect(camera, viewport);
  const provisional: FinanceNode =
    kind === 'job'
      ? { kind, id: '', name: 'Job', notes: '', position: { x: 0, y: 0 }, balances: [] }
      : { kind, id: '', name: 'Account', notes: '', position: { x: 0, y: 0 } };
  const size = sizeOf(provisional, selectNodeContent(diagram, provisional));
  const nodes = listPlacedNodes(diagram);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const contentOf = (node: FinanceNode) => selectNodeContent(diagram, node);
  const occupied = nodes.map((node) => padded(nodeRect(node, contentOf(node))));
  const connections: Point[][] = [];

  for (const id of diagram.flowOrder) {
    const flow = diagram.flows[id];
    if (!flow || !isFlowActive(diagram, flow)) continue;
    const fromNode = byId.get(flow.from);
    const toNode = byId.get(flow.to);
    if (!fromNode || !toNode) continue;
    connections.push(
      curvePoints(
        anchorPoint(fromNode, flow.fromAnchor, contentOf(fromNode)),
        anchorPoint(toNode, flow.toAnchor, contentOf(toNode)),
        flow.fromAnchor,
        flow.toAnchor,
      ),
    );
    if (flow.amount !== null && flow.amount > 0) {
      const from = anchorPoint(fromNode, flow.fromAnchor, contentOf(fromNode));
      const to = anchorPoint(toNode, flow.toAnchor, contentOf(toNode));
      const label = flowLabelPoint(from, to, flow.labelOffset);
      const width = Math.max(100, flow.label.trim().length * 9 + 28);
      occupied.push(padded({ left: label.x - width / 2, top: label.y - 26, width, height: 52 }));
    }
  }

  for (const node of nodes) {
    if (node.kind !== 'holding') continue;
    const account = byId.get(node.accountId);
    if (account?.kind !== 'account') continue;
    const anchors = facingAnchors(account, node, contentOf);
    connections.push(
      curvePoints(
        anchorPoint(account, anchors.from, contentOf(account)),
        anchorPoint(node, anchors.to, contentOf(node)),
        anchors.from,
        anchors.to,
      ),
    );
  }

  const free = (rect: Rect) => {
    if (occupied.some((node) => intersects(node, rect))) return false;
    const clearance = padded(rect);
    return !connections.some((points) =>
      points
        .slice(1)
        .some((point, index) => segmentIntersectsRect(points[index], point, clearance)),
    );
  };

  const search = (visibleOnly: boolean): Point | null => {
    const queue = new CandidateQueue();
    const seen = new Set<string>();
    queue.push(0, 0);
    seen.add('0,0');
    while (queue.length) {
      const offset = queue.pop()!;
      const rect = {
        left: center.x + offset.x * STEP - size.width / 2,
        top: center.y + offset.y * STEP - size.height / 2,
        width: size.width,
        height: size.height,
      };
      if ((!visibleOnly || inside(view, padded(rect))) && free(rect)) {
        return { x: rect.left, y: rect.top };
      }
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        const x = offset.x + dx;
        const y = offset.y + dy;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          visibleOnly &&
          (center.x + x * STEP < view.left ||
            center.x + x * STEP > view.left + view.width ||
            center.y + y * STEP < view.top ||
            center.y + y * STEP > view.top + view.height)
        ) {
          continue;
        }
        queue.push(x, y);
      }
    }
    return null;
  };

  return search(true) ?? search(false)!;
}
