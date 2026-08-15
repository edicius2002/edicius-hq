import type {
  Anchor,
  FinanceNode,
  Frame,
  NodeKind,
  Point,
  Rect,
  Size,
} from '@/features/finance/model/types';

export type { Rect, Size };

/**
 * Node footprints in canvas units. Kept here rather than read from the DOM so
 * flow paths can be computed without a layout pass, and so the money math and
 * the drawing never have to agree on anything but these numbers.
 *
 * **Height follows the rows a node actually shows.** It used to be one number
 * per kind, sized for the most that kind could ever display, which left most
 * boxes part empty: measured on the real diagram, an account or job holding one
 * asset carried 26px of slack in a 116px box, and a holding with no fee 17px.
 * Sixteen of its twenty-nine nodes are holdings.
 *
 * And the worst case it was sized for did not fit either. The box is in canvas
 * pixels while the content was in `rem`, so the two only agreed at a 16px root
 * font — at the 20px this app actually uses, a holding *with* a fee needed
 * 120.5px of a 116px box and the grid crushed a row to hide it. The row metrics
 * below are in pixels for that reason, and `FlowNode.module.css` states its
 * fonts in pixels to match: a box measured in canvas units cannot have contents
 * measured in something else.
 */

/**
 * The font sizes `FlowNode.module.css` states, in the same pixels.
 *
 * Duplicated deliberately, and guarded by a test: a stylesheet cannot be read
 * from here without a layout pass, and a layout pass is the one thing this file
 * exists to avoid. Written down once, and the height derived from it — a
 * hand-written height is how the first attempt reserved 15px for a row that
 * takes 15.4 and crushed it.
 */
const FONT = {
  /**
   * The corner label. It does **not** occupy a row: it is drawn in the node's
   * top padding, which is why the padding is asymmetric below. A kind that
   * everyone can already tell from the colour and the shape was costing a full
   * 16px row plus its gap on every node in the diagram.
   */
  kind: 7,
  /** Smaller than the numbers it introduces. A name is a label, not a figure. */
  name: 12,
  /**
   * The figure a holding exists to show. Its smaller 100px footprint needs a
   * quieter 12px figure, which still leads the compact box without clipping a
   * five-figure amount.
   */
  amount: 12,
  /**
   * Up from 11, but not as far as it wanted to go. The chips sit two to a fixed
   * column of 86px, so their size is capped by the widest amount that has to fit
   * one — measured, 13px pushed the widest past its column while 12 clears it.
   */
  balance: 12,
  fees: 9,
  operations: 9,
  muted: 11,
  /**
   * Smaller than a balance chip, because this row says a symbol, the paired
   * remaining/total amount, and the share — all on one line.
   *
   * The wider 240px account/job node leaves 220px inside its padding. That
   * clears 10px while keeping the two amounts together as one field.
   *
   *   font   real data   five figures   six figures   four-letter ticker + six
   *   8px      126           145            154              164
   *   9px      141           162            172              183  ← over
   *   10px     155           179            191              202
   *
   * 10px is the last safe size for the extreme case. The amount pair is clipped
   * as a unit when future data exceeds that measured ceiling.
   */
  allocation: 10,
} as const;

/** `.node` sets this; every row is one line of it. */
export const LINE_HEIGHT = 1.4;

/** Rounded up, always: half a pixel short is a crushed row. */
function rowHeight(font: number): number {
  return Math.ceil(font * LINE_HEIGHT);
}

const ROW = Object.fromEntries(
  Object.entries(FONT).map(([row, font]) => [row, rowHeight(font)]),
) as Record<keyof typeof FONT, number>;

export const NODE_FONT = FONT;
export const NODE_ROW = ROW;

/**
 * Asymmetric, because the corner label lives in the top of it rather than in a
 * row of its own. `PADDING_TOP` is the label's line box plus a hair; anything
 * less and a long name would run under it.
 */
const PADDING_TOP = 13;
const PADDING_BOTTOM = 8;
const ROW_GAP = 4;

/**
 * Asset chips go two to a line, so a node with eight assets is four lines tall
 * rather than eight rows tall.
 *
 * This is **exact, not an estimate**. `.balances` is a two-column grid, so the
 * count is fixed by the stylesheet rather than fitted to whatever widths the
 * amounts happen to have — which is the only way a height computed without a
 * layout pass can match what gets drawn. It was `flex-wrap` first: three narrow
 * chips fitted on a line where two wide ones did not, and the reservation could
 * only be an upper bound.
 *
 * Counting assets instead of lines is what made an eight-asset account 217px
 * tall — taller than the flat 116 this change set out to shrink.
 */
export const CHIPS_PER_LINE = 2;
const CHIP_GAP = 3;

/**
 * The gap *between* the two chip columns, which is not the gap between lines.
 *
 * `.balances` states `gap: 3px 7px`. Height only ever needed the row half; a
 * width measured from a single chip is what let a two-asset box reserve one
 * column and draw two, ellipsising both amounts it exists to show.
 */
export const CHIP_COLUMN_GAP = 7;

export function balancesHeight(assets: number): number {
  const lines = Math.ceil(assets / CHIPS_PER_LINE);
  return lines * ROW.balance + Math.max(0, lines - 1) * CHIP_GAP;
}

/**
 * An asset with outgoing flows: symbol, `remaining / total`, then the share
 * still free — all on one line, full width.
 *
 * One line rather than two, which means the whole of it has to fit 180px of
 * inner width. It does, at the smaller of the two font sizes here: the row is
 * measured in `FONT.allocation` rather than `FONT.balance` for exactly that
 * reason, and the two are kept apart so shrinking one cannot quietly reflow the
 * chips beside it.
 */
export function allocatedHeight(blocks: number): number {
  if (blocks <= 0) return 0;
  return blocks * ROW.allocation + Math.max(0, blocks - 1) * CHIP_GAP;
}

/**
 * The widest each kind is ever drawn — an upper bound, not the width itself.
 *
 * Both boxes that carry rows are measured from what they say and clamped to
 * this: a job showing one balance chip has no more business reserving 240px
 * than an account with one holding did. Holdings can bring an account below it
 * as well, and never above; see `holdingSpanWidth`.
 */
export const NODE_WIDTH: Record<NodeKind, number> = {
  job: 240,
  account: 240,
  holding: 93,
};

/**
 * The longest holding figure Finance promises to fit: `99,999.99`.
 *
 * The canvas is measured without the DOM, so text has to be expressed in the
 * same units as the boxes. `0.65em` is a conservative character width for the
 * monospace stack in the stylesheet, including its fallback fonts.
 */
const MAX_HOLDING_AMOUNT_CHARACTERS = '99,999.99'.length;
const TEXT_CHARACTER_EM = 0.65;
const HORIZONTAL_PADDING = 20;
const BORDER_WIDTH = 2;
const BOX_HORIZONTAL_CHROME = HORIZONTAL_PADDING + BORDER_WIDTH;

export function textWidth(characters: number, font: number): number {
  return Math.ceil(characters * font * TEXT_CHARACTER_EM);
}

/** A box around content of this width: its horizontal padding and borders. */
export function boxWidth(content: number): number {
  return Math.ceil(content) + BOX_HORIZONTAL_CHROME;
}

/** Width needed by the holding amount, including the node's horizontal chrome. */
export const HOLDING_CONTENT_WIDTH = boxWidth(
  textWidth(MAX_HOLDING_AMOUNT_CHARACTERS, FONT.amount),
);
/** Both a job and an account say "No assets yet" when they hold nothing. */
const EMPTY_NODE_CONTENT_WIDTH = boxWidth(textWidth('No assets yet'.length, FONT.muted));

/**
 * The shortest a box can be and still read.
 *
 * Two nodes of the same kind differing by a single row would otherwise differ by
 * fourteen pixels, which reads as misalignment rather than as information.
 */
/**
 * The shortest a box can be and still read.
 *
 * Lowered twice: once with the corner label, and again when the holding figure
 * came down to 14px. At 74 it padded three quarters of the diagram back to a
 * height none of them needed; at 48 it was still adding 7px of air to every
 * bare holding, measured — which is the empty space this section began with. Two nodes of the same kind differing by a row still differ by
 * that row, which is the point — the floor is for the degenerate case, not for
 * flattening the ones that have something to say.
 */
export const MIN_NODE_HEIGHT = 42;

/**
 * The room a stack of rows needs, floor not yet applied.
 *
 * The floor belongs at the end, once every block is counted. Applying it here
 * charged a short node the floor's padding *and* its balances on top — a flat
 * 18px of air on every single-line account and job, measured on the diagram.
 */
function stackHeight(rows: readonly (keyof typeof ROW)[], extra = 0): number {
  const content = rows.reduce((total, row) => total + ROW[row], 0);
  const blocks = rows.length + (extra > 0 ? 1 : 0);
  const gaps = Math.max(0, blocks - 1) * ROW_GAP;
  return PADDING_TOP + PADDING_BOTTOM + content + extra + gaps;
}

function heightOf(rows: readonly (keyof typeof ROW)[], extra = 0): number {
  return Math.max(MIN_NODE_HEIGHT, stackHeight(rows, extra));
}

/**
 * What a node has to say about itself, in rows.
 *
 * Every kind opens with its label and its name. What follows is answerable from
 * the document alone — whether a holding carries a fee, how many assets an
 * account still holds — which is what keeps this a pure function and the flow
 * paths a single pass.
 */
export type NodeContent = {
  /** Assets shown as chips, two to a line. Zero renders the "No assets yet" line. */
  assetRows?: number;
  /**
   * Assets with outgoing flows. Each is drawn as its own block of two lines —
   * the asset with its percentage, then what is left over what there was — so
   * it is counted apart from the chips rather than wrapping among them.
   */
  allocatedRows?: number;
  /** A holding with a fee on either side, or an account that has seen traffic. */
  extraRow?: boolean;
  /**
   * The smallest width the node's own rendered rows need. This is separate from
   * holdings: an account may be narrow on its own but need to span a wide
   * arrangement of the holdings it owns.
   */
  minimumWidth?: number;
  /** The real horizontal extent of an account's active holdings. */
  holdingSpanWidth?: number;
};

/**
 * How wide a box that carries rows is drawn: what its own content needs, or the
 * span of the holdings under it, whichever is larger — and never more than the
 * kind's bound.
 *
 * Both ends are clamped, and for the same reason. `NODE_WIDTH` is the widest
 * the kind is ever drawn, so neither a long name nor holdings dragged apart may
 * buy width past it; a caller that measured nothing gets the empty box rather
 * than the bound, because "I did not look" is not the same as "it is full".
 */
function contentWidth(kind: 'job' | 'account', content: NodeContent): number {
  const bound = NODE_WIDTH[kind];
  const own = Math.min(content.minimumWidth ?? EMPTY_NODE_CONTENT_WIDTH, bound);
  const span = Math.min(content.holdingSpanWidth ?? 0, bound);
  return Math.max(own, span);
}

export function sizeOf(node: FinanceNode, content: NodeContent = {}): Size {
  // No `kind` row: the label is drawn in the top padding, in the corner.
  const rows: (keyof typeof ROW)[] = [];

  if (node.kind === 'holding') {
    // A holding is its asset and its figure, and the asset is the corner label.
    // What is left in the body is the number, which is the whole point of it.
    rows.push('amount');
    if (content.extraRow) rows.push('fees');
    return { width: Math.max(NODE_WIDTH.holding, HOLDING_CONTENT_WIDTH), height: heightOf(rows) };
  }

  rows.push('name');

  const assets = content.assetRows ?? 0;
  const allocated = content.allocatedRows ?? 0;
  if (content.extraRow) rows.push('operations');

  // The balances block is one child of the node's grid, however many lines it
  // wraps to, so it is measured as a block rather than pushed as rows.
  const chips = assets > 0 ? balancesHeight(assets) : allocated > 0 ? 0 : ROW.muted;
  const blocks = allocatedHeight(allocated);
  const gapBetween = chips > 0 && blocks > 0 ? CHIP_GAP : 0;
  // A job is measured the same way an account is. It used to take the full 240
  // whatever it held, which on the real diagram meant a box more than twice as
  // wide as the single balance chip inside it — the same slack the accounts
  // were sized out of, left behind on the one kind that was not touched.
  return {
    width: contentWidth(node.kind, content),
    height: heightOf(rows, chips + blocks + gapBetween),
  };
}

/**
 * The tallest a kind can be, for anything that has to reserve room before it
 * knows what a node will say — placing a new one, or sizing a fixture.
 *
 * Spelled with the same rows `sizeOf` uses, and checked against it by a test:
 * left to itself this kept the rows from before the corner label and reserved
 * 107px for a box whose worst case is 70.
 */
export const NODE_SIZE: Record<NodeKind, Size> = {
  // Widths here are true upper bounds: `sizeOf` clamps both a node's own
  // content and any holdings' span to them, so nothing a diagram contains can
  // be drawn wider than the box reserved for it before it was read.
  job: { width: NODE_WIDTH.job, height: heightOf(['name', 'operations'], balancesHeight(1)) },
  account: {
    width: NODE_WIDTH.account,
    height: heightOf(['name', 'operations'], balancesHeight(1)),
  },
  holding: { width: NODE_WIDTH.holding, height: heightOf(['amount', 'fees']) },
};

/**
 * How a caller answers "what does this node show?" for a node it did not pick.
 *
 * Anything measuring a *set* of nodes needs this rather than a single content:
 * height follows the rows, so a bound taken over nodes measured as empty is a
 * bound around boxes nobody drew. The default measures nothing extra, which is
 * right for callers that have no diagram to ask — tests, and fixtures.
 */
export type ContentOf = (node: FinanceNode) => NodeContent;

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

/**
 * Where a connector meets a node.
 *
 * `content` matters here for the same reason it matters to a frame: a height
 * that follows the rows means measuring a node without knowing its rows lands
 * the line on a box that is not the one drawn. Callers with the diagram pass
 * `selectNodeContent`.
 */
export function anchorPoint(node: FinanceNode, anchor: Anchor, content?: NodeContent): Point {
  const size = sizeOf(node, content);
  const fraction = ANCHOR_FRACTIONS[anchor];
  return {
    x: node.position.x + size.width * fraction.x,
    y: node.position.y + size.height * fraction.y,
  };
}

export function centerOf(node: FinanceNode, content?: NodeContent): Point {
  const size = sizeOf(node, content);
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
  contentOf: ContentOf = () => ({}),
): { from: Anchor; to: Anchor } {
  const a = centerOf(source, contentOf(source));
  const b = centerOf(target, contentOf(target));
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: 'r', to: 'l' } : { from: 'l', to: 'r' };
  }
  return dy >= 0 ? { from: 'b', to: 't' } : { from: 't', to: 'b' };
}

/**
 * Everything the diagram reaches, with breathing room on all four sides.
 *
 * Measured in both directions rather than out from the origin: the canvas has no
 * corner, so a node dragged above or to the left of where the first one landed
 * is as much a part of the drawing as one dragged away from it. Frames count
 * too — one drawn past the last node is still part of the diagram. Fit and the
 * minimap read this, and they would lose whatever fell outside it.
 */
export function contentRect(
  nodes: FinanceNode[],
  frames: Frame[] = [],
  padding = 160,
  contentOf: ContentOf = () => ({}),
): Rect {
  if (!nodes.length && !frames.length) {
    return { left: 0, top: 0, width: padding * 2, height: padding * 2 };
  }

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const size = sizeOf(node, contentOf(node));
    left = Math.min(left, node.position.x);
    top = Math.min(top, node.position.y);
    right = Math.max(right, node.position.x + size.width);
    bottom = Math.max(bottom, node.position.y + size.height);
  }

  for (const frame of frames) {
    left = Math.min(left, frame.position.x);
    top = Math.min(top, frame.position.y);
    right = Math.max(right, frame.position.x + frame.size.width);
    bottom = Math.max(bottom, frame.position.y + frame.size.height);
  }

  return {
    left: left - padding,
    top: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}
