import { describe, expect, it } from 'vitest';

import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import CSS_SOURCE from './Positions.module.css?inline';

/**
 * The width of a position card, checked against the content it was derived
 * from — the one thing about this grid that jsdom cannot see.
 *
 * jsdom lays nothing out, so every test that renders this panel passes whether
 * the cards come out five across, one across, or wider than the page. The
 * arithmetic is therefore done here instead, against the same stylesheets that
 * ship, and in the unit the stylesheet actually resolves: this app sets
 * `--font-size-base: 125%`, so a rem is 20px. Decision 12.54 is the record of
 * what a length written in the other belief costs — a layout unreachable on the
 * machine it was designed for, with nothing red to say so.
 *
 * What this cannot prove is that Berkeley Mono really advances 0.6em a
 * character, that the browser's `auto-fill` agrees with `Math.floor`, or that
 * five cards across is pleasant to read. It proves the number in the stylesheet
 * is the number the derivation gives, so a card that grows a line cannot keep
 * the old width by accident.
 */

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const CSS = withoutComments(CSS_SOURCE);
const TOKENS = withoutComments(TOKENS_SOURCE);

/** What one rem is worth here, taken from the token rather than assumed. */
const REM_PX = (() => {
  const percent = /--font-size-base:\s*([\d.]+)%/.exec(TOKENS);
  expect(percent, 'tokens.css must state a base font size').not.toBeNull();
  return (16 * Number(percent?.[1])) / 100;
})();

/**
 * The body of a rule, found by the local class names its selector lists. A
 * renamed class fails loudly here rather than silently matching nothing.
 */
function rule(...locals: string[]): string {
  const selector = locals.map((local) => `\\._${local}_[0-9a-z]+`).join(',\\s*');
  const found = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(found, `.${locals.join(', .')} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

function token(name: string): number {
  const value = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(TOKENS);
  expect(value, `--${name} must be a rem token`).not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

function fontSize(body: string): number {
  const value = /font-size:\s*([\d.]+)rem/.exec(body);
  expect(value, 'the rule must set a font size in rem').not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

/** Berkeley Mono's advance, the estimate 12.53 sized the watchlist with. */
const ADVANCE = 0.6;

/**
 * `+12,345.67 · +123.45%`. The widest line a card must print whole: the value
 * above it is ten characters and the holding below it ellipsizes, so the return
 * is what sets the width.
 */
const RETURN_CHARACTERS = 21;

/** The `minmax()` floor the list declares, in pixels. */
const CARD_PX = (() => {
  const columns = /grid-template-columns:([^;]*);/.exec(rule('list'))?.[1] ?? '';
  const floor = /minmax\(\s*min\(\s*([\d.]+)rem\s*,\s*100%\s*\)/.exec(columns);
  expect(floor, 'the list must size its columns from a minmax floor in rem').not.toBeNull();
  return Number(floor?.[1]) * REM_PX;
})();

const GAP_PX = token(/gap:\s*var\(--(space-\d)\)/.exec(rule('list'))?.[1] ?? '');

describe('the width one position card is given', () => {
  it('is the widest line it has to print, plus its own padding and border', () => {
    const returnLine = RETURN_CHARACTERS * fontSize(rule('up', 'down')) * ADVANCE;
    const padding = 2 * token(/padding:\s*var\(--(space-\d)\)/.exec(rule('pick'))?.[1] ?? '');
    const border = 2;

    expect(REM_PX).toBe(20);
    expect(returnLine).toBeCloseTo(166.32, 2);
    expect(padding).toBe(20);

    // Rounded up to the next ten pixels, which is the only slack in the number.
    expect(CARD_PX).toBe(Math.ceil((returnLine + padding + border) / 10) * 10);
  });

  it('leaves room for the ticker beside the actions the card reveals on hover', () => {
    // Seven characters is `BTCUSDT`, the longest ticker this app quotes.
    const ticker = 7 * fontSize(rule('symbol')) * ADVANCE;
    const gutter = /padding-right:\s*([\d.]+)rem/.exec(rule('symbol'));
    expect(gutter, 'the symbol must reserve the actions corner').not.toBeNull();

    // Two buttons of 18.4px — a 0.7rem glyph at 0.6em, padded var(--space-1)
    // either side — a 2px gap between them and var(--space-1) of padding
    // around the pair, which is 48.8px, plus the 5px it is inset from the edge.
    expect(Number(gutter?.[1]) * REM_PX).toBeGreaterThanOrEqual(53.8);
    expect(ticker + Number(gutter?.[1]) * REM_PX).toBeLessThanOrEqual(CARD_PX);
  });
});

describe('how many cards that puts across the panel', () => {
  /** What `auto-fill` fits into a panel of this outer width. */
  function columnsAt(panelWidth: number): number {
    const content = panelWidth - 2 * token('space-4');
    return Math.floor((content + GAP_PX) / (CARD_PX + GAP_PX));
  }

  it('is five on the page width this app was measured at', () => {
    // 1141px is the usable page on a 1536px window, measured for 12.54, less
    // the var(--space-4) the panel spends on padding either side.
    expect(columnsAt(1141)).toBe(5);
  });

  it('collapses a column at a time and reaches one rather than overflowing', () => {
    expect(columnsAt(900)).toBe(4);
    expect(columnsAt(700)).toBe(3);
    expect(columnsAt(480)).toBe(2);
    expect(columnsAt(300)).toBe(1);

    // The floor is `min(9.5rem, 100%)`, so the single column shrinks with the
    // panel instead of pushing a scrollbar under the page.
    expect(rule('list')).toMatch(/minmax\(\s*min\([\d.]+rem,\s*100%\)/);
  });

  it('lets the grid count the columns rather than naming a number', () => {
    const columns = /grid-template-columns:([^;]*);/.exec(rule('list'))?.[1] ?? '';

    expect(columns).toMatch(/auto-fill/);
    // `repeat(4, ...)` and friends: a count written here is a count that is
    // wrong at every width but the one it was typed at.
    expect(columns).not.toMatch(/repeat\(\s*\d/);
  });
});
