import { describe, expect, it } from 'vitest';

import {
  anchorPoint,
  centerOf,
  contentBounds,
  facingAnchors,
  flowLabelPoint,
  flowPath,
  NODE_SIZE,
} from '@/features/finance/lib/geometry';
import type { FinanceNode } from '@/features/finance/model/types';

function account(id: string, x: number, y: number): FinanceNode {
  return { id, kind: 'account', name: id, notes: '', position: { x, y } };
}

describe('anchorPoint', () => {
  const node = account('a', 100, 200);
  const { width, height } = NODE_SIZE.account;

  it('puts corners on the box corners', () => {
    expect(anchorPoint(node, 'tl')).toEqual({ x: 100, y: 200 });
    expect(anchorPoint(node, 'br')).toEqual({ x: 100 + width, y: 200 + height });
  });

  it('puts sides at the middle of each edge', () => {
    expect(anchorPoint(node, 'r')).toEqual({ x: 100 + width, y: 200 + height / 2 });
    expect(anchorPoint(node, 't')).toEqual({ x: 100 + width / 2, y: 200 });
  });

  it('agrees with the centre', () => {
    const center = centerOf(node);
    expect(center.x).toBe(anchorPoint(node, 'r').x - width / 2);
    expect(center.y).toBe(anchorPoint(node, 'b').y - height / 2);
  });
});

describe('facingAnchors', () => {
  it('leaves right and arrives left when the target is to the right', () => {
    expect(facingAnchors(account('a', 0, 0), account('b', 500, 0))).toEqual({
      from: 'r',
      to: 'l',
    });
  });

  it('flips when the target is to the left', () => {
    expect(facingAnchors(account('a', 500, 0), account('b', 0, 0))).toEqual({
      from: 'l',
      to: 'r',
    });
  });

  it('goes vertical when the gap is mostly vertical', () => {
    expect(facingAnchors(account('a', 0, 0), account('b', 0, 500))).toEqual({
      from: 'b',
      to: 't',
    });
    expect(facingAnchors(account('a', 0, 500), account('b', 0, 0))).toEqual({
      from: 't',
      to: 'b',
    });
  });
});

describe('flowPath', () => {
  it('starts and ends on the points it is given', () => {
    const path = flowPath({ x: 10, y: 20 }, { x: 300, y: 120 }, 'r', 'l');
    expect(path.startsWith('M 10 20')).toBe(true);
    expect(path.endsWith('300 120')).toBe(true);
  });

  it('bulges out of the side each anchor sits on', () => {
    const path = flowPath({ x: 100, y: 0 }, { x: 400, y: 0 }, 'r', 'l');
    const [, controls] = path.split(' C ');
    const [c1x, , c2x] = controls.replace(/,/g, '').split(' ').map(Number);
    // The source pushes right, the target pulls back left.
    expect(c1x).toBeGreaterThan(100);
    expect(c2x).toBeLessThan(400);
  });

  it('keeps a usable curve even when the ends nearly touch', () => {
    const path = flowPath({ x: 0, y: 0 }, { x: 4, y: 0 }, 'r', 'l');
    expect(path).toContain('C');
  });
});

describe('flowLabelPoint', () => {
  it('sits between the ends', () => {
    expect(flowLabelPoint({ x: 0, y: 0 }, { x: 100, y: 50 }, null)).toEqual({ x: 50, y: 25 });
  });

  it('honours a manual nudge', () => {
    expect(flowLabelPoint({ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 10, y: -5 })).toEqual({
      x: 60,
      y: 20,
    });
  });
});

describe('contentBounds', () => {
  it('covers the furthest node plus breathing room', () => {
    const bounds = contentBounds([account('a', 0, 0), account('b', 400, 300)], 100);
    expect(bounds.width).toBe(400 + NODE_SIZE.account.width + 100);
    expect(bounds.height).toBe(300 + NODE_SIZE.account.height + 100);
  });

  it('is just the padding when there is nothing to cover', () => {
    expect(contentBounds([], 160)).toEqual({ width: 160, height: 160 });
  });
});
