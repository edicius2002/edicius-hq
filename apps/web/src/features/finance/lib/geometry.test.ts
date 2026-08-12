import { describe, expect, it } from 'vitest';

import {
  anchorPoint,
  centerOf,
  allocatedHeight,
  balancesHeight,
  CHIPS_PER_LINE,
  contentRect,
  facingAnchors,
  flowLabelPoint,
  flowPath,
  LINE_HEIGHT,
  MIN_NODE_HEIGHT,
  NODE_FONT,
  NODE_ROW,
  NODE_SIZE,
  sizeOf,
} from '@/features/finance/lib/geometry';
import type { FinanceNode, Frame } from '@/features/finance/model/types';

function account(id: string, x: number, y: number): FinanceNode {
  return { id, kind: 'account', name: id, notes: '', position: { x, y } };
}

describe('anchorPoint', () => {
  const node = account('a', 100, 200);
  // Measured the way it is drawn. A height follows the rows a node shows, so a
  // test that assumed the kind's worst case would be asserting against a box
  // nobody renders.
  const { width, height } = sizeOf(node);

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

describe('contentRect', () => {
  const { width, height } = sizeOf(account('a', 0, 0));

  function frame(x: number, y: number, w: number, h: number): Frame {
    return { id: 'f1', name: 'Frame', position: { x, y }, size: { width: w, height: h } };
  }

  it('covers the furthest node plus breathing room on every side', () => {
    const rect = contentRect([account('a', 0, 0), account('b', 400, 300)], [], 100);
    expect(rect).toEqual({
      left: -100,
      top: -100,
      width: 400 + width + 200,
      height: 300 + height + 200,
    });
  });

  it('reaches nodes that sit above and left of the origin', () => {
    const rect = contentRect([account('a', -600, -400), account('b', 200, 100)], [], 100);
    expect(rect.left).toBe(-700);
    expect(rect.top).toBe(-500);
    expect(rect.left + rect.width).toBe(200 + width + 100);
    expect(rect.top + rect.height).toBe(100 + height + 100);
  });

  it('holds a diagram that is entirely on the negative side', () => {
    const rect = contentRect([account('a', -1000, -1000)], [], 100);
    expect(rect.left).toBe(-1100);
    expect(rect.width).toBe(width + 200);
    expect(rect.width).toBeGreaterThan(0);
  });

  it('reaches a frame drawn past the last node', () => {
    const rect = contentRect([account('a', 0, 0)], [frame(900, 700, 400, 300)], 100);
    expect(rect.left + rect.width).toBe(900 + 400 + 100);
    expect(rect.top + rect.height).toBe(700 + 300 + 100);
  });

  it('reaches a frame drawn above and left of every node', () => {
    const rect = contentRect([account('a', 0, 0)], [frame(-800, -600, 200, 200)], 100);
    expect(rect.left).toBe(-900);
    expect(rect.top).toBe(-700);
  });

  it('is a padded square around the origin when there is nothing to cover', () => {
    expect(contentRect([], [], 160)).toEqual({ left: 0, top: 0, width: 320, height: 320 });
  });
});

describe('a box that follows its rows', () => {
  const account = (): FinanceNode => ({
    id: 'a1',
    kind: 'account',
    name: 'Account',
    notes: '',
    position: { x: 0, y: 0 },
  });
  const holding = (): FinanceNode => ({
    id: 'h1',
    kind: 'holding',
    name: 'Holding',
    notes: '',
    asset: 'USD',
    amount: 1,
    active: true,
    accountId: 'a1',
    fees: { in: null, out: null },
    position: { x: 0, y: 0 },
  });

  it('reserves at least what a row actually takes', () => {
    /*
     * The heights are derived from the font sizes rather than written down,
     * because the first attempt wrote them down: it reserved 15px for a row
     * that takes 15.4 and the grid crushed it — the exact failure the old
     * "generous" sizing was trying to avoid.
     */
    for (const [row, font] of Object.entries(NODE_FONT)) {
      expect(NODE_ROW[row as keyof typeof NODE_FONT]).toBeGreaterThanOrEqual(font * LINE_HEIGHT);
    }
  });

  it('is shorter for a node with less to say', () => {
    const bare = sizeOf(holding(), { extraRow: false });
    const withFee = sizeOf(holding(), { extraRow: true });

    expect(bare.height).toBeLessThan(withFee.height);
    // And both are tighter than the single 116 every kind used to take.
    expect(withFee.height).toBeLessThan(116);
  });

  it('grows a line per row of asset chips, not a row per asset', () => {
    // The chips wrap. Two assets sit beside each other and cost one line;
    // counting them as rows instead is what made the eight-asset account 217px
    // tall — taller than the flat 116 this change set out to shrink.
    const one = sizeOf(account(), { assetRows: 1 });
    const two = sizeOf(account(), { assetRows: CHIPS_PER_LINE });
    const overflowing = sizeOf(account(), { assetRows: CHIPS_PER_LINE + 1 });

    expect(two.height).toBe(one.height);
    expect(overflowing.height).toBeGreaterThan(two.height);
  });

  it('reserves the lines the chips actually wrap to', () => {
    // Measured on the real diagram: eight assets settle into four lines, and
    // the block they make is 71px tall. Reserving less crushes a row and hides
    // an asset, which is why this rounds up rather than fitting exactly.
    expect(balancesHeight(8)).toBeGreaterThanOrEqual(71);
    expect(balancesHeight(8)).toBeLessThan(71 + NODE_ROW.balance);
  });

  it('is tighter than the flat height it replaces, at the sizes the diagram has', () => {
    // The asset counts on the real document. Every account but one holds two
    // or fewer, and those now come in under the 116 they all used to take.
    for (const assets of [1, 2]) {
      expect(sizeOf(account(), { assetRows: assets, extraRow: true }).height).toBeLessThan(116);
    }
    // The eight-asset account is genuinely taller than one row — it has eight
    // balances to show. What it must not be is the 217 that counting assets
    // as rows produced.
    expect(sizeOf(account(), { assetRows: 8, extraRow: true }).height).toBeLessThan(160);
  });

  it('shows the empty line rather than collapsing to nothing', () => {
    // An account with no assets still says "No assets yet", which is a row.
    expect(sizeOf(account(), { assetRows: 0 }).height).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT);
  });

  it('never goes below the floor, so two nodes cannot look misaligned', () => {
    expect(sizeOf(account(), { assetRows: 0 }).height).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT);
    expect(sizeOf(holding(), {}).height).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT);
  });

  it('keeps the wider top-level boxes and compacts holdings', () => {
    expect(sizeOf(account(), {}).width).toBe(240);
    expect(sizeOf(holding(), {}).width).toBe(88);
  });

  it('reserves the tallest case for anything that has to guess', () => {
    // Placing a new node happens before it has anything to say. Checked against
    // `sizeOf` rather than against a number: written down, this kept the rows
    // from before the corner label and reserved 107px for a 70px box.
    expect(NODE_SIZE.holding.height).toBe(sizeOf(holding(), { extraRow: true }).height);
    expect(NODE_SIZE.account.height).toBe(
      sizeOf(account(), { assetRows: 1, extraRow: true }).height,
    );
  });
});

describe('an asset with flows leaving it', () => {
  const account = (): FinanceNode => ({
    id: 'a1',
    kind: 'account',
    name: 'Account',
    notes: '',
    position: { x: 0, y: 0 },
  });

  it('reserves one line per allocated asset, at its own size', () => {
    // Symbol, what is left, what there was and the share, all on one row. The
    // row is set smaller than a balance chip so the four parts clear 180px, and
    // the height has to follow that size rather than the chips'.
    expect(allocatedHeight(1)).toBe(NODE_ROW.allocation);
    expect(allocatedHeight(2)).toBe(NODE_ROW.allocation * 2 + 3);
    expect(allocatedHeight(0)).toBe(0);
  });

  it('costs no more than the chip it replaces', () => {
    // One row either way, and the allocated row is the smaller font, so showing
    // the whole story is not paid for in height.
    const asChip = sizeOf(account(), { assetRows: 1 });
    const asRow = sizeOf(account(), { assetRows: 0, allocatedRows: 1 });

    expect(asRow.height).toBeLessThanOrEqual(asChip.height);
  });

  it('does not also pay for the empty line, having something to say', () => {
    // `assetRows: 0` normally means "No assets yet". With a block present there
    // is no such line, and reserving it would leave a node with a row of air.
    // Two allocated rows rather than one, so both sides of the comparison clear
    // MIN_NODE_HEIGHT — at the floor the difference is whatever the floor left
    // over, which measures the floor rather than the rule.
    const withBlock = sizeOf(account(), { assetRows: 0, allocatedRows: 2 });
    const bothWays = sizeOf(account(), { assetRows: 2, allocatedRows: 2 });

    // One line of chips, plus the gap between the two groups.
    expect(bothWays.height - withBlock.height).toBe(NODE_ROW.balance + 3);
  });

  it('still derives from the document alone', () => {
    // Two nodes with the same content are the same size, whatever they hold.
    expect(sizeOf(account(), { assetRows: 3, allocatedRows: 2 })).toEqual(
      sizeOf(account(), { assetRows: 3, allocatedRows: 2 }),
    );
  });
});
