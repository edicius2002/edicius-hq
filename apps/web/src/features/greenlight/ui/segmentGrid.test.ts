import { describe, expect, it } from 'vitest';

import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import PAGE_SOURCE from './GreenlightPage.module.css?inline';
import MONTH_SOURCE from './MoneyWeekChart.module.css?inline';
import CSS_SOURCE from './SegmentSummary.module.css?inline';

/**
 * How many fee cards sit in a row, how wide that leaves one, and whether the
 * widest thing a card has to print still fits inside it.
 *
 * The same test as `moneyWeekGrid` and for the same reason: jsdom lays nothing
 * out, so `SegmentSummary.test.tsx` passes whether the cards come out three
 * across, one across or overlapping, and whether `Fee (under min) $0,00` fits
 * on its line or runs off the card. The arithmetic is therefore done here,
 * against the stylesheets that ship and in the unit they resolve — this app
 * sets `--font-size-base: 125%`, so a rem is 20px.
 *
 * Measured in Chrome at the owner's window on 2026-08-22, before any of it was
 * written down: the list is 1099.2px, a card 356.4px and 323.2px inside its
 * padding, the widest metric line `Fee (under min) $0,00` 201.4px and the
 * widest header `17/04 → 07/05 4 weeks` 228.1px.
 */

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const CSS = withoutComments(CSS_SOURCE);
const TOKENS = withoutComments(TOKENS_SOURCE);
const MONTHS = withoutComments(MONTH_SOURCE);
const PAGE = withoutComments(PAGE_SOURCE);

const REM_PX = (() => {
  const percent = /--font-size-base:\s*([\d.]+)%/.exec(TOKENS);
  expect(percent, 'tokens.css must state a base font size').not.toBeNull();
  return (16 * Number(percent?.[1])) / 100;
})();

function token(name: string): number {
  const value = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(TOKENS);
  expect(value, `--${name} must be a rem token`).not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

/**
 * The body of a rule, found by the local class names its selector lists. A
 * renamed class fails loudly here rather than silently matching nothing.
 */
function ruleIn(source: string, ...locals: string[]): string {
  const selector = locals.map((local) => `\\._${local}_[0-9a-z]+`).join(',\\s*');
  const found = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(source);
  expect(found, `.${locals.join(', .')} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

const rule = (...locals: string[]) => ruleIn(CSS, ...locals);

/** The body of a `.local tag { }` rule — `.metric span`, `.metric strong`. */
function partRule(local: string, tag: string): string {
  const found = new RegExp(`\\._${local}_[0-9a-z]+\\s+${tag}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(found, `.${local} ${tag} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

/** How many equal tracks a `repeat(n, ...)` names, or 1 for a single column. */
function trackCount(body: string): number {
  const columns = /grid-template-columns:([^;]*);/.exec(body)?.[1] ?? '';
  expect(columns, 'the rule must set grid-template-columns').not.toBe('');
  const repeat = /repeat\(\s*(\d+)\s*,/.exec(columns);
  if (repeat) return Number(repeat[1]);
  expect(columns).toMatch(/minmax\(0,\s*1fr\)/);
  return 1;
}

/** Every `@media (max-width: Npx)` width in a stylesheet, in source order. */
function breakpoints(source: string): number[] {
  return [...source.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((match) =>
    Number(match[1]),
  );
}

/** The body of one `@media (max-width: Npx)` block, braces matched. */
function media(source: string, maxWidth: number): string {
  const head = new RegExp(`@media\\s*\\(max-width:\\s*${maxWidth}px\\)\\s*\\{`).exec(source);
  expect(head, `the stylesheet must carry a (max-width: ${maxWidth}px) query`).not.toBeNull();
  const open = (head?.index ?? 0) + (head?.[0].length ?? 0);
  let level = 1;
  let scan = open;
  while (scan < source.length && level > 0) {
    if (source[scan] === '{') level += 1;
    if (source[scan] === '}') level -= 1;
    scan += 1;
  }
  return source.slice(open, scan - 1);
}

function fontSize(body: string): number {
  const value = /font-size:\s*([\d.]+)rem/.exec(body);
  expect(value, 'the rule must set a font size in rem').not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

/** The list at the owner's window, and what the window spends before it. */
const LIST_PX = 1099.2;
const CHROME_PX = 436.8;

/** Berkeley Mono's advance, the estimate 12.53 sized the watchlist with. */
const ADVANCE = 0.6;

/**
 * `Fee (under min)`. The longest label a card prints — three characters longer
 * than `Fee (10%)`, and the one that decides how much room the label side of a
 * metric line needs.
 */
const LABEL_CHARACTERS = 'Fee (under min)'.length;

/**
 * `$12,345.67`. The longest figure a segment can print. A segment's gross is a
 * whole payment period rather than a week, the archive already holds one of
 * $6,451.32, and `formatMoney` follows the reader's own locale — so ten
 * characters, grouped, is what the line has to hold, rather than the eight the
 * owner's own locale writes for the same amount today.
 */
const FIGURE_CHARACTERS = '$12,345.67'.length;

/** Padding both sides, the 3px accent border and the 1px border opposite it. */
const CARD_CHROME_PX = 2 * token('space-3') + 3 + 1;

/** The widest line the ledger has to print whole: label, gap, figure. */
const METRIC_PX =
  LABEL_CHARACTERS * fontSize(partRule('metric', 'span')) * ADVANCE +
  0.4 * REM_PX +
  FIGURE_CHARACTERS * fontSize(partRule('metric', 'strong')) * ADVANCE;

describe('how many fee cards sit in a row', () => {
  it('is three at the window this app was measured at', () => {
    expect(REM_PX).toBe(20);
    expect(trackCount(rule('list'))).toBe(3);
  });

  it('falls to two and then to one rather than squeezing three at every width', () => {
    expect(trackCount(ruleIn(media(CSS, 1486), 'list'))).toBe(2);
    expect(trackCount(ruleIn(media(CSS, 1116), 'list'))).toBe(1);
  });

  it('folds at the same widths the month boxes above it fold at', () => {
    // Both grids are inside the one Weeks panel. A window where the months have
    // gone to two columns while the fee cards under them are still three reads
    // as a mistake, whichever of the two is right on its own.
    expect(breakpoints(CSS)).toEqual(breakpoints(MONTHS).slice(0, 2));
  });
});

describe('the width three across leaves a card', () => {
  const GAP_PX = token('space-3');
  const CARD_PX = (LIST_PX - 2 * GAP_PX) / 3;
  const INSIDE_PX = CARD_PX - CARD_CHROME_PX;

  it('is 356.4px, and 322.4px inside its own padding', () => {
    expect(CARD_PX).toBeCloseTo(356.4, 1);
    expect(INSIDE_PX).toBeCloseTo(322.4, 1);
    // `--space-4` a side is what a full-width card could afford. This one
    // cannot: 40px against 356.4px leaves the widest metric line 10px short.
    expect(rule('card')).toContain('padding: var(--space-3)');
  });

  it('holds the longest label beside the longest figure on one line', () => {
    expect(METRIC_PX).toBeCloseTo(269, 0);
    expect(METRIC_PX).toBeLessThanOrEqual(INSIDE_PX);
  });

  it('sizes the ledger from that line rather than from a guess', () => {
    const columns = /grid-template-columns:([^;]*);/.exec(rule('metrics'))?.[1] ?? '';
    const floor = /minmax\(\s*min\(\s*([\d.]+)rem\s*,\s*100%\s*\)/.exec(columns);
    expect(floor, 'the ledger must size its columns from a minmax floor').not.toBeNull();

    const declared = Number(floor?.[1]) * REM_PX;
    expect(declared).toBeGreaterThanOrEqual(METRIC_PX);
    // One metric to a line at a third of a row; two once a card has the whole
    // list, which is what `auto-fit` is counting rather than a media query.
    expect(Math.floor(INSIDE_PX / declared)).toBe(1);
    expect(columns).toMatch(/auto-fit/);
    // `min(..., 100%)` and not a bare floor: measured, a bare 13.5rem pushed
    // the ledger 24px out of its own card at a 650px window.
    expect(columns).toMatch(/minmax\(\s*min\([\d.]+rem,\s*100%\)/);
  });

  it('stacks the range above the ledger rather than beside it', () => {
    // Range, gap and three metrics side by side needed 774px of line and the
    // card has 322.4px. That row was never narrowable, only wrappable.
    expect(rule('card')).toMatch(/display:\s*grid/);
    expect(rule('metrics')).not.toMatch(/margin-inline-start:\s*auto/);
    expect(rule('metric')).toMatch(/justify-content:\s*space-between/);
  });
});

/**
 * Every breakpoint checked against the card's own floor. This grid follows the
 * month grid above it by choice, so what is proved here is that the choice is
 * always the safe direction: the months give a column up before these cards
 * need to.
 */
describe('the widths the columns are given up at', () => {
  const GAP_PX = token('space-3');
  const FLOOR_CARD_PX = METRIC_PX + CARD_CHROME_PX;

  /** The window at which `columns` cards stop holding their widest line. */
  function windowFor(columns: number): number {
    return columns * FLOOR_CARD_PX + (columns - 1) * GAP_PX + CHROME_PX;
  }

  it('needs less window than the month grid gives it, at three across', () => {
    expect(FLOOR_CARD_PX).toBeCloseTo(303, 0);
    expect(windowFor(3)).toBeCloseTo(1375.8, 1);
    expect(windowFor(3)).toBeLessThanOrEqual(breakpoints(CSS)[0]);
  });

  it('and at two across', () => {
    expect(windowFor(2)).toBeCloseTo(1057.8, 1);
    expect(windowFor(2)).toBeLessThanOrEqual(breakpoints(CSS)[1]);
  });

  it('still holds three across at the window it was asked for', () => {
    expect(windowFor(3)).toBeLessThanOrEqual(1536);
  });
});

/**
 * The height the page holds open for the first marker's two segments. It is a
 * length in `GreenlightPage.module.css` computed entirely out of lengths in
 * `SegmentSummary.module.css`, which is the arrangement that drifts.
 */
describe('the space held open for the first two segments', () => {
  it('is one row of these cards, plus the margin the list holds itself off by', () => {
    const reserve = /min-height:\s*([\d.]+)rem/.exec(ruleIn(PAGE, 'segmentsSlot'));
    expect(reserve, 'the slot must reserve a height in rem').not.toBeNull();

    /** Nothing here sets a line height, so every line is the body's 1.5. */
    const line = (size: number) => size * 1.5;
    const card =
      2 * token('space-3') +
      2 +
      line(REM_PX) +
      token('space-2') +
      3 * line(fontSize(partRule('metric', 'strong'))) +
      2 * token('space-1');
    const row = card + token('space-4');

    expect(card).toBeCloseTo(176.5, 1);
    expect(row).toBeCloseTo(196.5, 1);
    // Two segments are one row now, not two stacked cards. Keeping the old
    // 8.5rem would put 26px of page under the cursor on the first marker click.
    expect(Number(reserve?.[1]) * REM_PX).toBeGreaterThanOrEqual(row);
  });
});
