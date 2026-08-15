import { describe, expect, it } from 'vitest';

import { createEmptyDiagram } from '@/features/finance/lib/document';
import {
  contains,
  frameMembers,
  frameRect,
  listPlacedNodes,
  nodeRect,
  ownerFrameOf,
  rectBetween,
  resizeRect,
} from '@/features/finance/lib/frames';
import { NODE_SIZE } from '@/features/finance/lib/geometry';
import { addAccount, addFrame, addHolding, addJob } from '@/features/finance/lib/operations';
import type { Diagram, Frame, Point, Size } from '@/features/finance/model/types';

function withJob(diagram: Diagram, id: string, position: Point): Diagram {
  return addJob(diagram, { id, position });
}

function withFrame(diagram: Diagram, id: string, position: Point, size: Size): Diagram {
  return addFrame(diagram, { id, position, size });
}

/** A frame generous enough to hold a job placed at the same origin. */
function around(position: Point): { position: Point; size: Size } {
  return {
    position: { x: position.x - 40, y: position.y - 40 },
    size: { width: NODE_SIZE.job.width + 80, height: NODE_SIZE.job.height + 80 },
  };
}

describe('contains', () => {
  const outer = { left: 0, top: 0, width: 100, height: 100 };

  it('accepts a rectangle inside', () => {
    expect(contains(outer, { left: 10, top: 10, width: 50, height: 50 })).toBe(true);
  });

  it('accepts one that touches the edges', () => {
    expect(contains(outer, { left: 0, top: 0, width: 100, height: 100 })).toBe(true);
  });

  it('refuses one that pokes out on any side', () => {
    expect(contains(outer, { left: 60, top: 10, width: 50, height: 10 })).toBe(false);
    expect(contains(outer, { left: -1, top: 10, width: 10, height: 10 })).toBe(false);
    expect(contains(outer, { left: 10, top: 60, width: 10, height: 50 })).toBe(false);
  });
});

describe('rectBetween', () => {
  it('does not care which corner was dragged from', () => {
    const forwards = rectBetween({ x: 10, y: 20 }, { x: 110, y: 220 });
    const backwards = rectBetween({ x: 110, y: 220 }, { x: 10, y: 20 });
    expect(forwards).toEqual({ left: 10, top: 20, width: 100, height: 200 });
    expect(backwards).toEqual(forwards);
  });
});

describe('ownerFrameOf', () => {
  it('claims a node it fully contains', () => {
    const at = { x: 200, y: 200 };
    const box = around(at);
    let diagram = withJob(createEmptyDiagram('d'), 'j1', at);
    diagram = withFrame(diagram, 'f1', box.position, box.size);

    expect(ownerFrameOf(diagram, diagram.nodes.j1)).toBe('f1');
  });

  it('leaves a node it only overlaps', () => {
    let diagram = withJob(createEmptyDiagram('d'), 'j1', { x: 200, y: 200 });
    const node = nodeRect(diagram.nodes.j1);
    // Cuts through the node rather than enclosing it — measured from the box
    // itself, because a node is only as wide as its content: written down, this
    // frame stopped cutting anything the moment an empty job stopped taking the
    // full 240, and quietly became the contained case.
    diagram = withFrame(
      diagram,
      'f1',
      { x: node.left + node.width / 2, y: 160 },
      { width: 200, height: 200 },
    );

    expect(node.width).toBeGreaterThan(0);
    expect(ownerFrameOf(diagram, diagram.nodes.j1)).toBeNull();
  });

  it('gives a node inside two frames to the smaller one', () => {
    const at = { x: 300, y: 300 };
    const tight = around(at);
    let diagram = withJob(createEmptyDiagram('d'), 'j1', at);
    diagram = withFrame(diagram, 'wide', { x: 0, y: 0 }, { width: 900, height: 900 });
    diagram = withFrame(diagram, 'tight', tight.position, tight.size);

    expect(ownerFrameOf(diagram, diagram.nodes.j1)).toBe('tight');
  });

  it('is unmoved by the order the frames were drawn in', () => {
    const at = { x: 300, y: 300 };
    const tight = around(at);
    let diagram = withJob(createEmptyDiagram('d'), 'j1', at);
    diagram = withFrame(diagram, 'tight', tight.position, tight.size);
    diagram = withFrame(diagram, 'wide', { x: 0, y: 0 }, { width: 900, height: 900 });

    expect(ownerFrameOf(diagram, diagram.nodes.j1)).toBe('tight');
  });

  it('breaks an equal-area tie in favour of the newer frame', () => {
    const at = { x: 300, y: 300 };
    const box = around(at);
    let diagram = withJob(createEmptyDiagram('d'), 'j1', at);
    diagram = withFrame(diagram, 'older', box.position, box.size);
    diagram = withFrame(diagram, 'newer', box.position, box.size);

    expect(ownerFrameOf(diagram, diagram.nodes.j1)).toBe('newer');
  });

  it('cannot claim a holding that is switched off', () => {
    let diagram = addAccount(createEmptyDiagram('d'), { id: 'a1', position: { x: 300, y: 300 } });
    const added = addHolding(diagram, {
      id: 'h1',
      accountId: 'a1',
      asset: 'USD',
      position: { x: 300, y: 300 },
    });
    if (!added.ok) throw new Error('the holding should have been added');
    diagram = added.value;
    diagram = withFrame(diagram, 'f1', { x: 0, y: 0 }, { width: 900, height: 900 });

    expect(ownerFrameOf(diagram, diagram.nodes.h1)).toBe('f1');

    // Out of play means off the canvas, so no rectangle can be around it.
    const dormant = {
      ...diagram,
      nodes: { ...diagram.nodes, h1: { ...diagram.nodes.h1, active: false } },
    } as Diagram;
    expect(ownerFrameOf(dormant, dormant.nodes.h1)).toBeNull();
    expect(listPlacedNodes(dormant).map((node) => node.id)).toEqual(['a1']);
  });
});

describe('frameMembers', () => {
  it('lists only what the frame holds', () => {
    let diagram = withJob(createEmptyDiagram('d'), 'inside', { x: 100, y: 100 });
    diagram = withJob(diagram, 'outside', { x: 2000, y: 2000 });
    diagram = withFrame(diagram, 'f1', { x: 0, y: 0 }, { width: 600, height: 600 });

    expect(frameMembers(diagram, 'f1').map((node) => node.id)).toEqual(['inside']);
  });

  it('is empty for a frame that encloses nothing', () => {
    let diagram = withJob(createEmptyDiagram('d'), 'j1', { x: 2000, y: 2000 });
    diagram = withFrame(diagram, 'f1', { x: 0, y: 0 }, { width: 400, height: 400 });

    expect(frameMembers(diagram, 'f1')).toEqual([]);
  });
});

describe('frameRect', () => {
  it('is the position and the size', () => {
    const frame: Frame = {
      id: 'f1',
      name: 'Frame',
      position: { x: 12, y: 34 },
      size: { width: 200, height: 300 },
    };
    expect(frameRect(frame)).toEqual({ left: 12, top: 34, width: 200, height: 300 });
  });
});

describe('resizeRect', () => {
  const rect = { left: 100, top: 100, width: 400, height: 300 };
  const min = { width: 180, height: 150 };

  it('pulls the east side without moving the west one', () => {
    expect(resizeRect(rect, 'e', { x: 60, y: 0 }, min)).toEqual({ ...rect, width: 460 });
  });

  it('pulls the west side and keeps the east one still', () => {
    const next = resizeRect(rect, 'w', { x: 60, y: 0 }, min);
    expect(next.left).toBe(160);
    expect(next.width).toBe(340);
    expect(next.left + next.width).toBe(rect.left + rect.width);
  });

  it('pulls the north side and keeps the south one still', () => {
    const next = resizeRect(rect, 'n', { x: 0, y: -50 }, min);
    expect(next.top).toBe(50);
    expect(next.height).toBe(350);
    expect(next.top + next.height).toBe(rect.top + rect.height);
  });

  it('moves both sides of a corner', () => {
    const next = resizeRect(rect, 'se', { x: 40, y: 30 }, min);
    expect(next).toEqual({ left: 100, top: 100, width: 440, height: 330 });
  });

  it('leaves the axis it was not pulled on alone', () => {
    expect(resizeRect(rect, 'e', { x: 60, y: 999 }, min).height).toBe(rect.height);
    expect(resizeRect(rect, 's', { x: 999, y: 60 }, min).width).toBe(rect.width);
  });

  it('stops at the minimum instead of turning inside out', () => {
    const next = resizeRect(rect, 'e', { x: -9999, y: 0 }, min);
    expect(next.width).toBe(min.width);
    expect(next.left).toBe(rect.left);
  });

  it('stops the moving edge too, so a squeezed frame does not walk away', () => {
    const next = resizeRect(rect, 'w', { x: 9999, y: 0 }, min);
    expect(next.width).toBe(min.width);
    // The east side never moved, so the west one can only come this far.
    expect(next.left + next.width).toBe(rect.left + rect.width);
  });
});
