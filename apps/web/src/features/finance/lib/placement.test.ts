import { describe, expect, it } from 'vitest';

import { createEmptyDocument } from '@/features/finance/lib/document';
import { nodeRect } from '@/features/finance/lib/frames';
import { sizeOf } from '@/features/finance/lib/geometry';
import { addAccount, addJob } from '@/features/finance/lib/operations';
import { placeNewNode } from '@/features/finance/lib/placement';
import type { Diagram, Point, Rect } from '@/features/finance/model/types';

const view = { camera: { x: 0, y: 0, zoom: 1 }, viewport: { width: 800, height: 600 } };

function empty(): Diagram {
  return createEmptyDocument('default').diagrams[0];
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

function placedRect(position: Point, kind: 'job' | 'account'): Rect {
  const node =
    kind === 'job'
      ? { kind, id: 'new', name: 'Job', notes: '', balances: [], position }
      : { kind, id: 'new', name: 'Account', notes: '', position };
  return nodeRect(node);
}

describe('placeNewNode', () => {
  it('centers both kinds in the current camera view when space is empty', () => {
    for (const kind of ['job', 'account'] as const) {
      const position = placeNewNode(empty(), kind, {
        camera: { x: -300, y: -200, zoom: 2 },
        viewport: view.viewport,
      });
      const rect = placedRect(position, kind);
      expect(rect.left + rect.width / 2).toBe(350);
      expect(rect.top + rect.height / 2).toBe(250);
    }
  });

  it('finds a nearby visible slot when the center is occupied by a node', () => {
    const diagram = addJob(empty(), { id: 'existing', position: { x: 340, y: 270 } });
    const position = placeNewNode(diagram, 'account', view);
    const rect = placedRect(position, 'account');
    expect(overlaps(rect, nodeRect(diagram.nodes.existing))).toBe(false);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(800);
    expect(rect.top + rect.height).toBeLessThanOrEqual(600);
    expect(
      Math.hypot(rect.left + rect.width / 2 - 400, rect.top + rect.height / 2 - 300),
    ).toBeLessThan(180);
  });

  it('avoids a visible flow running across the center', () => {
    let diagram = addJob(empty(), { id: 'left', position: { x: 100, y: 270 } });
    diagram = addJob(diagram, { id: 'right', position: { x: 600, y: 270 } });
    diagram.nodes.left = {
      ...diagram.nodes.left,
      kind: 'job',
      balances: [{ asset: 'USD', amount: 100, active: true }],
    };
    diagram.flows.flow = {
      id: 'flow',
      from: 'left',
      to: 'right',
      fromAnchor: 'r',
      toAnchor: 'l',
      amount: 10,
      asset: 'USD',
      label: '',
      notes: '',
      labelOffset: null,
    };
    diagram.flowOrder.push('flow');

    const withoutFlow = { ...diagram, flows: {}, flowOrder: [] };
    const centered = placeNewNode(withoutFlow, 'account', view);
    const placed = placeNewNode(diagram, 'account', view);
    expect(centered).not.toEqual(placed);

    const rect = placedRect(placed, 'account');
    const lineY = nodeRect(diagram.nodes.left).top + sizeOf(diagram.nodes.left).height / 2;
    expect(rect.top + rect.height + 16 <= lineY || rect.top - 16 >= lineY).toBe(true);
  });

  it('avoids account ownership links that cross the center', () => {
    let diagram = addAccount(empty(), { id: 'account', position: { x: 100, y: 270 } });
    diagram = {
      ...diagram,
      nodes: {
        ...diagram.nodes,
        holding: {
          id: 'holding',
          kind: 'holding',
          name: 'USD',
          notes: '',
          position: { x: 600, y: 270 },
          accountId: 'account',
          asset: 'USD',
          amount: 10,
          fees: { in: null, out: null },
          active: true,
        },
      },
      nodeOrder: [...diagram.nodeOrder, 'holding'],
    };
    const withoutLink = { ...diagram, nodeOrder: ['account'] };
    expect(placeNewNode(diagram, 'job', view)).not.toEqual(placeNewNode(withoutLink, 'job', view));
  });

  it('avoids a flow label nudged away from its line', () => {
    let diagram = addJob(empty(), { id: 'left', position: { x: 100, y: 100 } });
    diagram = addJob(diagram, { id: 'right', position: { x: 600, y: 100 } });
    diagram.nodes.left = {
      ...diagram.nodes.left,
      kind: 'job',
      balances: [{ asset: 'USD', amount: 100, active: true }],
    };
    diagram.flows.flow = {
      id: 'flow',
      from: 'left',
      to: 'right',
      fromAnchor: 'r',
      toAnchor: 'l',
      amount: 10,
      asset: 'USD',
      label: 'Paycheck',
      notes: '',
      labelOffset: { x: 0, y: 170 },
    };
    diagram.flowOrder.push('flow');
    const position = placeNewNode(diagram, 'account', view);
    expect(position).not.toEqual(
      placeNewNode({ ...diagram, flows: {}, flowOrder: [] }, 'account', view),
    );
  });

  it('uses the updated diagram for consecutive additions', () => {
    const first = placeNewNode(empty(), 'job', view);
    const diagram = addJob(empty(), { id: 'first', position: first });
    const second = placeNewNode(diagram, 'account', view);
    expect(overlaps(placedRect(first, 'job'), placedRect(second, 'account'))).toBe(false);
  });

  it('searches outside a crowded viewport when no full node can fit inside it', () => {
    const tinyView = { camera: view.camera, viewport: { width: 80, height: 60 } };
    const diagram = addJob(empty(), { id: 'existing', position: { x: -20, y: -20 } });
    const position = placeNewNode(diagram, 'account', tinyView);
    expect(overlaps(placedRect(position, 'account'), nodeRect(diagram.nodes.existing))).toBe(false);
  });
});
