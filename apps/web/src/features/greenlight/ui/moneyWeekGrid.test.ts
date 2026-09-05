import { describe, expect, it } from 'vitest';

import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import CSS_SOURCE from './MoneyWeekChart.module.css?inline';

/**
 * How many month boxes sit in a row and how many week cards sit across a month —
 * the two things about this grid that jsdom cannot see.
 *
 * jsdom lays nothing out, so every test that renders the Weeks panel passes
 * whether the months come out three across, two across or one, and whether a
 * four-week month draws its weeks on one row or on two. The arithmetic is done
 * here instead, against the stylesheet that ships and in the unit that
 * stylesheet resolves: this app sets `--font-size-base: 125%`, so a rem is 20px.
 * `positionsGrid.test.ts` is the same test for the Investing cards and the same
 * reasoning; 12.54 is the record of what a length written in 16-px rems costs.
 *
 * Every figure below was measured in Chrome at the owner's window on
 * 2026-08-22 — 1536px CSS, root font 20px, 125% Windows scale — before it was
 * written down: the list is 1099.2px, a month box 366.4px, and a week card
 * 69.9px in the middle column and 73.7px in the outer two. What this file
 * proves is that the numbers in the stylesheet still give that layout, so a
 * card that grows a line cannot keep four across by accident.
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

function token(name: string): number {
  const value = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(TOKENS);
  expect(value, `--${name} must be a rem token`).not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

/** The stylesheet with every `@media` block cut out of it. */
const TOP_LEVEL = (() => {
  let out = '';
  let index = 0;
  while (index < CSS.length) {
    if (CSS.startsWith('@media', index)) {
      const open = CSS.indexOf('{', index);
      let level = 1;
      let scan = open + 1;
      while (scan < CSS.length && level > 0) {
        if (CSS[scan] === '{') level += 1;
        if (CSS[scan] === '}') level -= 1;
        scan += 1;
      }
      index = scan;
      continue;
    }
    out += CSS[index];
    index += 1;
  }
  return out;
})();

/** The body of one `@media (max-width: Npx)` block, braces matched. */
function media(maxWidth: number): string {
  const head = new RegExp(`@media\\s*\\(max-width:\\s*${maxWidth}px\\)\\s*\\{`).exec(CSS);
  expect(head, `the stylesheet must carry a (max-width: ${maxWidth}px) query`).not.toBeNull();
  const open = (head?.index ?? 0) + (head?.[0].length ?? 0);
  let level = 1;
  let scan = open;
  while (scan < CSS.length && level > 0) {
    if (CSS[scan] === '{') level += 1;
    if (CSS[scan] === '}') level -= 1;
    scan += 1;
  }
  return CSS.slice(open, scan - 1);
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

const rule = (...locals: string[]) => ruleIn(TOP_LEVEL, ...locals);

/** How many equal tracks a `repeat(n, ...)` names, or 1 for a single column. */
function trackCount(body: string): number {
  const columns = /grid-template-columns:([^;]*);/.exec(body)?.[1] ?? '';
  expect(columns, 'the rule must set grid-template-columns').not.toBe('');
  const repeat = /repeat\(\s*(\d+)\s*,/.exec(columns);
  if (repeat) return Number(repeat[1]);
  expect(columns).toMatch(/minmax\(0,\s*1fr\)/);
  return 1;
}

function pxLength(body: string, property: string): number {
  const value = new RegExp(`${property}:\\s*([\\d.]+)(rem|px)`).exec(body);
  expect(value, `the rule must set ${property}`).not.toBeNull();
  return value?.[2] === 'rem' ? Number(value?.[1]) * REM_PX : Number(value?.[1]);
}

/**
 * The list, measured in Chrome at the owner's window: 1536px CSS less the
 * sidebar (15rem), the main padding (2× space-6), the panel padding
 * (2× space-4), the panel borders and the scrollbar.
 */
const LIST_PX = 1099.2;

/** What the window spends before the list starts: 1536 − 1099.2, measured. */
const CHROME_PX = 436.8;

/** Half a gutter, on each side of every vertical rule. */
const GUTTER_PX = token('space-2');

/** Berkeley Mono's advance, the estimate 12.53 sized the watchlist with. */
const ADVANCE = 0.6;

/**
 * `$4,272.50`. The widest weekly figure the archive holds, written the longest
 * way a reader can be shown it: `formatMoney` follows the browser's own locale,
 * so the same amount is `$4272,50` on the owner's machine and `$4,272.50` in
 * `en-US`. Nine characters is the one of those two the card has to hold.
 */
const WEEK_FIGURE_CHARACTERS = 9;

/** `47.1% of` — the longer of the two lines the percentage pill wraps onto. */
const PCT_LINE_CHARACTERS = 8;

function fontSize(body: string): number {
  const value = /font-size:\s*([\d.]+)rem/.exec(body);
  expect(value, 'the rule must set a font size in rem').not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

describe('how many month boxes sit in a row', () => {
  it('is three at the window this app was measured at', () => {
    expect(REM_PX).toBe(20);
    expect(trackCount(rule('list'))).toBe(3);
  });

  it('falls to two and then to one rather than squeezing three at every width', () => {
    expect(trackCount(ruleIn(media(1486), 'list'))).toBe(2);
    expect(trackCount(ruleIn(media(1116), 'list'))).toBe(1);
  });

  it('keeps the gutters it takes out of the cards down to half a space-2 a side', () => {
    // Two columns could afford `--space-5` a side. Three cannot: at three
    // columns every pixel of gutter comes out of a week card, and 60px of it
    // either side of two rules is most of one.
    expect(rule('monthRow')).toContain('padding: var(--space-5) var(--space-2)');
    expect(GUTTER_PX).toBe(10);
  });

  it('places its rules by the same count the tracks are declared with', () => {
    // `nth-child(3n + 1)` opens a row and `nth-child(3n)` closes one. Three
    // tracks placed by a two-column rule is a vertical rule down a card.
    expect(TOP_LEVEL).toMatch(/nth-child\(3n \+ 1\)\s*\{[^}]*padding-inline-start:\s*0/);
    expect(TOP_LEVEL).toMatch(/nth-child\(3n\)\s*\{[^}]*padding-inline-end:\s*0/);
    expect(media(1486)).toMatch(/nth-child\(odd\)\s*\{[^}]*padding-inline-start:\s*0/);
  });

  it('finds the last row by where the row starts, not by counting back', () => {
    // `nth-last-child(-n + 3)` alone is right only when the month count is a
    // multiple of the column count: five months in two columns dropped the rule
    // under the second row, because the fourth of five matched it while a third
    // row still sat below. The first box of the last row is the one in column
    // one with at most two boxes after it; every box after that one is in it.
    expect(TOP_LEVEL).toContain('nth-child(3n + 1):nth-last-child(-n + 3) ~');
    expect(media(1486)).toContain('nth-child(2n + 1):nth-last-child(-n + 2) ~');
  });
});

describe('how many week cards sit across a month', () => {
  const CELL_PX = LIST_PX / 3;
  /** The middle column pays the inline gutter twice; it is the narrowest. */
  const CONTENT_PX = CELL_PX - 2 * GUTTER_PX;
  const TRACK_PX = CONTENT_PX / trackCount(rule('weeks'));
  const MARKER_PX = pxLength(rule('markerSlot'), 'width');
  const CARD_PX = TRACK_PX - MARKER_PX;
  /** 3px of padding and 1px of border, each side. */
  const CARD_INSIDE_PX = CARD_PX - 2 * (3 + 1);

  it('is four, on one row, at the window this app was measured at', () => {
    expect(trackCount(rule('weeks'))).toBe(4);
    expect(CELL_PX).toBeCloseTo(366.4, 1);
    expect(CONTENT_PX).toBeCloseTo(346.4, 1);
    expect(TRACK_PX).toBeCloseTo(86.6, 1);
    expect(CARD_PX).toBeCloseTo(72.6, 1);
  });

  it('gives the widest weekly figure a line of its own inside that card', () => {
    const figure = WEEK_FIGURE_CHARACTERS * fontSize(rule('weekValue')) * ADVANCE;

    expect(CARD_INSIDE_PX).toBeCloseTo(64.6, 1);
    expect(figure).toBeCloseTo(60.5, 1);
    expect(figure).toBeLessThanOrEqual(CARD_INSIDE_PX);
    // It stays on one line, so a figure that outgrew the card would be caught
    // here rather than wrapped in the middle of an amount.
    expect(rule('weekValue')).toMatch(/white-space:\s*nowrap/);
  });

  it('lets the percentage wrap rather than dropping the words after it', () => {
    const line = PCT_LINE_CHARACTERS * fontSize(rule('weekPct')) * ADVANCE;
    const padding = 2 * 4 + 2;

    expect(line + padding).toBeLessThanOrEqual(CARD_INSIDE_PX);
    // `of month` is not shortened and 47.1 is not rounded to 47: the pill is
    // two lines deep instead.
    expect(rule('weekPct')).not.toMatch(/white-space:\s*nowrap/);
    expect(rule('weekRange')).not.toMatch(/white-space:\s*nowrap/);
  });

  it('draws every card in a row the same width, marker or no marker', () => {
    // The last week of the archive is the one week drawn without a marker. The
    // gutter is reserved on the cluster and the marker is pulled back over it,
    // so that week's card is not the width of a card and a half.
    expect(pxLength(rule('weekCluster'), 'padding-inline-end')).toBe(MARKER_PX);
    expect(rule('markerSlot')).toContain(`margin: 0 -${MARKER_PX / REM_PX}rem 0 0`);
    expect(rule('weekCard')).not.toMatch(/max-width/);
  });

  it('falls to two across and then to one rather than four at every width', () => {
    expect(trackCount(ruleIn(media(766), 'weeks'))).toBe(2);
    expect(trackCount(ruleIn(media(601), 'weeks'))).toBe(1);
  });
});

/**
 * Every breakpoint in the file, derived from one length: the narrowest card that
 * can still print its own figure. A number typed here that the arithmetic does
 * not give is a column count that is right at the width it was typed at and
 * wrong at every other.
 */
describe('the widths the columns are given up at', () => {
  /** Card, plus its 3px of padding and 1px of border either side. */
  const FLOOR_CARD_PX = WEEK_FIGURE_CHARACTERS * fontSize(rule('weekValue')) * ADVANCE + 8;
  const FLOOR_TRACK_PX = FLOOR_CARD_PX + pxLength(rule('markerSlot'), 'width');
  /** What a month cell needs to hold four of them. */
  const FLOOR_CELL_PX = 4 * FLOOR_TRACK_PX;

  /** The window at which `columns` month cells stop holding four cards each. */
  function windowFor(columns: number): number {
    // The narrowest cell is the list divided by the column count, less a gutter
    // on each side that faces another cell: two in the middle of three, one of
    // two, none at all when the months are single file.
    const gutters = Math.min(2, columns - 1);
    return columns * (FLOOR_CELL_PX + gutters * GUTTER_PX) + CHROME_PX;
  }

  it('gives up the third month column where the middle cell stops fitting', () => {
    expect(FLOOR_CARD_PX).toBeCloseTo(68.5, 1);
    expect(FLOOR_CELL_PX).toBeCloseTo(329.9, 1);
    expect(windowFor(3)).toBeCloseTo(1486.6, 1);
    expect(CSS).toContain('@media (max-width: 1486px)');
  });

  it('gives up the second one at the same reckoning, a gutter cheaper', () => {
    expect(windowFor(2)).toBeCloseTo(1116.6, 1);
    expect(CSS).toContain('@media (max-width: 1116px)');
  });

  it('gives up the third and fourth week column once the months are single file', () => {
    // One month column and no gutters: the cell is the whole list.
    expect(windowFor(1)).toBeCloseTo(766.7, 1);
    expect(2 * FLOOR_TRACK_PX + CHROME_PX).toBeCloseTo(601.8, 1);
    expect(CSS).toContain('@media (max-width: 766px)');
    expect(CSS).toContain('@media (max-width: 601px)');
  });

  it('still holds three months and four weeks at the window it was asked for', () => {
    expect(windowFor(3)).toBeLessThanOrEqual(1536);
  });

  /*
   * The phone step, which reads like a contradiction of the 1116px rule above
   * and is not. Every width in this block prices a month cell at four week
   * cards. Below 601px the weeks are already single file, so the cell holds
   * one — and two cells of one card each are a quarter of what two cells of
   * four cost. One month per row below 640px was the 1116px rule outliving its
   * own premise, not a width that had been measured.
   */
  it('takes the second month column back once a cell holds one card, not four', () => {
    const cellFloor = FLOOR_TRACK_PX;

    expect(FLOOR_CELL_PX).toBeCloseTo(4 * cellFloor, 1);
    // Two cells and the one gutter between them, against the list a 360px
    // phone leaves: 223px, measured in the drawer shell where there is no
    // sidebar to subtract.
    expect(2 * cellFloor + GUTTER_PX).toBeLessThanOrEqual(223);
    expect(trackCount(ruleIn(media(640), 'list'))).toBe(2);
  });

  it('matches the width at which the shell drops its top row', () => {
    // 640 is `NARROW_QUERY` in `useIsNarrow.ts`. The list is given its width by
    // the shell, so the two have to name the same number; `narrowBreakpoint`
    // guards the other side of the same seam.
    expect(CSS).toContain('@media (max-width: 640px)');
  });
});

describe('the month heading at two columns on a phone', () => {
  /*
   * `.monthTitle` is `minmax(0, 1fr) auto`: the month, then its total. `auto`
   * is sized to the total, and in a 101px box the total took 89px — the
   * month's track collapsed to 1.7px and the name printed over the figure. A
   * `1fr` track goes to zero, which is what `minmax(0, ...)` promises.
   */
  it('stacks the month over its total rather than sharing a line', () => {
    expect(trackCount(ruleIn(media(640), 'monthTitle'))).toBe(1);
  });

  it('puts the total on its own row, left aligned under the month', () => {
    const total = /\._monthTitle_[0-9a-z]+ strong\s*\{([^}]*)\}/.exec(media(640))?.[1] ?? '';

    expect(total, 'the narrow block must place the total').not.toBe('');
    expect(total).toMatch(/grid-row:\s*2/);
    expect(total).toMatch(/justify-self:\s*start/);
  });

  it('keeps every heading the same number of lines, which is what levels the row', () => {
    // The base rule's note asks for a fixed line count so that boxes sharing a
    // row start their week cards level. Three lines keeps that as well as two
    // did — what breaks it is a heading that wraps a different number of times
    // per box. So the chips must be pinned to a row, not left to flow.
    expect(ruleIn(media(640), 'toolChips')).toMatch(/grid-row:\s*3/);
  });
});
