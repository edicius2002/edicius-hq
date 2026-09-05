import { describe, expect, it } from 'vitest';

import PAGE_SOURCE from './AirfarePage.module.css?inline';
import LIST_SOURCE from './RouteList.module.css?inline';
import MAP_SOURCE from './RouteMap.module.css?inline';

/**
 * Whether a long watchlist scrolls or grows the page, checked by reading the
 * stylesheets — 12.269.
 *
 * jsdom lays nothing out and implements no containment, so every test that
 * renders this page passes whether the rows scroll inside the row they share
 * with the map or push it a thousand pixels taller. That is not a theoretical
 * gap: the Investing rail shipped with `flex: 1 1 0` and no containment,
 * looked right in every test, and grew its row in a browser until 276530a
 * found it. This is the same mechanism and it gets the same guard.
 *
 * The wiring is across two files on purpose. The width at which the page
 * stacks is `AirfarePage.module.css`'s decision and exists there once; the
 * scroller reads three custom properties rather than carrying a second copy of
 * `1080px`. So what has to be checked is that the two halves still meet.
 */

/**
 * Comments come out first: the prose in both files quotes the very
 * declarations being matched for, and a regex cannot tell an explanation from
 * a rule.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const PAGE = withoutComments(PAGE_SOURCE);
const LIST = withoutComments(LIST_SOURCE);
const MAP = withoutComments(MAP_SOURCE);

/** The body of a rule, found by the local class name the source declares. */
function rule(local: string, from: string): string {
  const found = new RegExp(`\\._${local}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(from);
  expect(found, `.${local} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

/**
 * The body of the block that stacks the two panels.
 *
 * Counted rather than matched: the block holds a rule, so a lazy `}` stops at
 * the wrong one and a greedy one runs to the end of the file.
 */
function stacked(): string {
  const opened = PAGE.indexOf('@media (max-width: 1080px)');
  expect(opened, 'the stacking media query must exist').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = PAGE.indexOf('{', opened); i < PAGE.length; i += 1) {
    if (PAGE[i] === '{') depth += 1;
    if (PAGE[i] === '}') {
      depth -= 1;
      if (depth === 0) return PAGE.slice(PAGE.indexOf('{', opened) + 1, i);
    }
  }
  throw new Error('the stacking media query is never closed');
}

describe('the watchlist scrolls rather than growing the row it sits in', () => {
  it('stretches the row so the map and the watchlist reach the same height', () => {
    // `start` would let each panel end at its own content, which is the ragged
    // gap this layout exists to remove.
    expect(rule('top', PAGE)).toMatch(/align-items:\s*stretch/);
  });

  it('sizes the rows as if they were empty, so a long list cannot grow the row', () => {
    /*
     * The load-bearing one, and the one that looks unnecessary. A growable
     * flex item contributes all of its content to its container's intrinsic
     * height whatever its basis, and a scroll container's max-content size is
     * its content too — so without size containment a watchlist longer than
     * the map pushes the row taller and leaves the map with a gap under it.
     * `flex: 1 1 0` is only what then spends the height the map settled on.
     */
    expect(rule('top', PAGE)).toMatch(/--airfare-routes-contain:\s*size/);
    expect(rule('top', PAGE)).toMatch(/--airfare-routes-flex:\s*1 1 0/);
    expect(rule('top', PAGE)).toMatch(/--airfare-routes-cap:\s*none/);
  });

  it('hands the height back to the rows where there is no row to share', () => {
    // Stacked, nothing above has a height to give, and a box sized as if it
    // were empty inside a box of no height is a box of no height — the rows
    // would disappear instead of scrolling.
    const block = stacked();
    expect(block).toMatch(/--airfare-routes-contain:\s*none/);
    expect(block).toMatch(/--airfare-routes-flex:\s*0 1 auto/);
    expect(block).toMatch(/--airfare-routes-cap:\s*[\d.]+rem/);
  });

  it('reads all three from the page rather than keeping its own copy of the breakpoint', () => {
    // The drift this arrangement exists to prevent: a second `1080px` in the
    // list's own stylesheet would be a threshold nobody remembers to move
    // twice. Checked by absence, because that is the failure.
    const box = rule('listBox', LIST);
    expect(box).toMatch(/contain:\s*var\(--airfare-routes-contain/);
    expect(box).toMatch(/flex:\s*var\(--airfare-routes-flex/);
    expect(box).toMatch(/max-height:\s*var\(--airfare-routes-cap/);
    expect(LIST).not.toContain('1080');

    /*
     * Checked by subject rather than by absence.
     *
     * This used to read `expect(LIST).not.toMatch(/@media[^{]*width/)` — no
     * width query in this file at all. That was a proxy for the real rule and
     * it outgrew it: the drift being guarded against is a *second copy of the
     * row's threshold*, not a media query as such, and the file now carries a
     * phone block that sizes type and touches none of the mechanism. Banning
     * the construct instead of the mistake would have meant either giving up
     * that block or weakening the guard to nothing.
     *
     * So every width query here is read, and none of them may set the three
     * custom properties the page owns or name the page's own breakpoint.
     */
    for (const block of LIST.matchAll(/@media ([^{]*)\{([\s\S]*?)\n\}/g)) {
      expect(block[2], 'a media query here may not set the row mechanism').not.toMatch(
        /--airfare-routes-/,
      );
      expect(block[1], 'a media query here may not restate the page breakpoint').not.toContain(
        '1080',
      );
    }
  });

  it('leaves the scroller a scroller, with a floor of zero to shrink to', () => {
    // `min-height: 0` on both boxes: a flex item's automatic minimum size is
    // its content, which is the other way a list refuses to shrink.
    expect(rule('listBox', LIST)).toMatch(/min-height:\s*0/);
    const list = rule('list', LIST);
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).toMatch(/min-height:\s*0/);
    // The platform's own answer to "is there more below", drawn rather than
    // left to an overlay scrollbar that fades away.
    expect(list).toMatch(/scrollbar-width:\s*thin/);
  });
});

/**
 * The row's two dimensions, and the arithmetic that decides both —
 * `a-taller-row-is-four-more-routes`.
 *
 * The same problem the block above has, from the other side: jsdom lays
 * nothing out, so nothing that renders this page can tell you how many rows
 * fit in it, or how narrow the panel can get before a month is painted across
 * the control beside it. What can be checked is that the numbers in the three
 * stylesheets still add up to the counts their own comments claim — so a later
 * hand that moves `min-height` or the column without redoing the sums is told
 * which sum it broke.
 *
 * Every figure below is written out in `RouteMap.module.css` at `.stage` and
 * in `RouteList.module.css` at `.collect`. They are repeated here rather than
 * imported because there is nothing to import: they are what a browser
 * computes out of `tokens.css` and a monospace face, and this file's job is to
 * hold the stylesheets to them.
 */

/** `tokens.css` sets `--font-size-base: 125%`, so a rem is twenty pixels. */
const REM = 20;

/** One monospace advance, at a font size given in rem. Berkeley Mono is 0.6em. */
function advance(size: number): number {
  return size * REM * 0.6;
}

/** The panel's own `--space-4` padding either side and its 1px borders. */
const PANEL_CHROME = 2 * REM + 2;

/** The `<n>rem` bounds of the watchlist column, in pixels. */
function column(): { floor: number; ceiling: number } {
  const found = /minmax\(\s*([\d.]+)rem\s*,\s*([\d.]+)rem\s*\)/.exec(rule('top', PAGE));
  expect(found, 'the watchlist column must be a rem minmax').not.toBeNull();
  return { floor: Number(found?.[1]) * REM, ceiling: Number(found?.[2]) * REM };
}

/** A `<n>px` declaration, in pixels. */
function pixels(source: string, property: string): number {
  const found = new RegExp(`${property}:\\s*([\\d.]+)px`).exec(source);
  expect(found, `${property} must be declared in pixels`).not.toBeNull();
  return Number(found?.[1]);
}

describe('how wide the watchlist may be, and what stops it being narrower', () => {
  it('pins row actions to the right while letting the route label yield first', () => {
    const row = rule('row', LIST);
    const route = rule('route', LIST);
    const actions = rule('actions', LIST);

    expect(row).toMatch(/flex-wrap:\s*nowrap/);
    expect(route).toMatch(/flex:\s*1 1 0/);
    expect(actions).toMatch(/margin-left:\s*auto/);
  });

  /*
   * The route button's own content, at the 7px gap `.route` declares: a swatch
   * and the pair, and nothing else.
   *
   * The month used to be a third column here — one leg carrying
   * `September 2027`, since 12.110 made it a month and 12.113 took the second
   * leg away. The months are controls now
   * (`a-watch-is-a-pair-and-its-months`), and a `<button>` may not contain
   * buttons, so they left this grid for a group beside it.
   */
  const SWATCH = 8;
  const PAIR = 4 * advance(0.78) + advance(0.62) + 4 * advance(0.78);
  const GAPS_IN_ROUTE = 7;

  /*
   * The month tabs, at the four the row puts on one line.
   *
   * A cell prints `Nov` — three advances at 0.66rem — inside 3px of padding
   * either side and a 1px border it carries whether or not it is drawn, so a
   * hover cannot move the row. Four of them at `.months`' own 3px gaps.
   *
   * **Four, and every watched month drawn.** The row used to draw three and a
   * `+N` counter, which fitted a 22rem column and told the reader only how many
   * months they could not see. Four cells are 136.04px against the 135.08 that
   * column left between the pair and the collect control, which is why the floor
   * below is 22.1rem: the fourth tab is the two pixels.
   *
   * A watch with more than four is a line taller per four, and that is the whole
   * cost — a tab is 20.48px against the row's own 38.5, so the first line is
   * free and only the rows that ask pay for the rest.
   */
  const MONTH_TAB = 3 * advance(0.66) + 2 * 3 + 2;
  const MONTHS = 4 * MONTH_TAB + 3 * 3;

  /** The route button's own padding, `--space-2` either side, and its border. */
  const ROUTE_CHROME = 2 * (REM * 0.5) + 2;
  /** `Remove`, a `small` ghost button: six advances inside the same chrome. */
  const REMOVE = 'Remove'.length * advance(0.8) + 2 * (REM * 0.5) + 2;
  /** The collect mark, 12px inside that chrome. */
  const COLLECT = 12 + 2 * (REM * 0.5) + 2;
  /** `.row`'s own `--space-2` between its children. */
  const BESIDE = REM * 0.5;

  /** A row still being watched: the route, its months, the collect mark, Remove. */
  const WATCHED =
    SWATCH + GAPS_IN_ROUTE + PAIR + ROUTE_CHROME + MONTHS + COLLECT + REMOVE + 3 * BESIDE;

  /*
   * A departed row, which is now the *narrower* of the two.
   *
   * It loses the collect control and a gap, and `Departed` no longer widens
   * anything: it was a fourth child of the route button's three-track grid,
   * where it wrapped under the swatch and pushed that `auto` track from 8px to
   * its own eight advances. `flex-basis: 100%` puts it on a line of its own
   * instead, so it costs height on the rows that have stopped collecting and
   * width on none of them.
   */
  const DEPARTED = SWATCH + GAPS_IN_ROUTE + PAIR + ROUTE_CHROME + MONTHS + REMOVE + 2 * BESIDE;

  const FLOOR = Math.max(WATCHED, DEPARTED) + PANEL_CHROME;

  it('is the watched row that sets the floor, now that Departed wraps', () => {
    /*
     * The inversion, and it is worth pinning in both directions. It used to be
     * the departed row by 10.4px, because dropping a control widened the row —
     * which is the opposite of the intuition and was the reason it was written
     * down. Now `Departed` takes a line rather than a track, so the row with
     * the most controls is the widest, which is the intuition after all.
     */
    expect(WATCHED).toBeGreaterThan(DEPARTED);
    // 433.6 before this feature, 425.0 with three tabs and a counter, 441.0
    // with four. The month that left the route button paid for two of them and
    // `Departed` wrapping paid for a third; the fourth is what the column's
    // floor moved 2px to cover.
    expect(FLOOR).toBeCloseTo(441.0, 1);
  });

  it('never lets the column go below the widest row it can draw', () => {
    /*
     * The failure this exists for is `fix/route-detail-fits`. `.dates` carries
     * `min-width: 0`, so the grid does not push back: a month too wide for its
     * track overruns it and paints across the control beside it. Nothing
     * throws, nothing wraps, and the row simply lies.
     */
    const { floor, ceiling } = column();
    expect(floor, 'the column floor must fit the widest row').toBeGreaterThanOrEqual(FLOOR);
    // And it fits by 1.04px, which is the whole reason the floor is 22.1rem and
    // not 22: four tabs are what a row draws now, and they only just go in.
    expect(floor - FLOOR).toBeLessThan(2);
    expect(ceiling, 'the column ceiling must fit it too').toBeGreaterThanOrEqual(FLOOR);
  });

  it('is as narrow as that floor allows and no narrower, so the map has the rest', () => {
    /*
     * The owner asked for the map to grow to the right and the watchlist to
     * come in, and the map's track is `1fr` — so this number is the map's
     * width as much as it is the list's.
     *
     * The slack went 26.4 → 35.0 when the month left the route button, and back
     * to 19.0 when the fourth tab arrived. The ceiling has not moved through any
     * of it: 23rem is what the owner asked the map to grow to, and this column
     * has spent its own slack rather than the map's.
     */
    const { ceiling } = column();
    expect(ceiling).toBe(23 * REM);
    expect(ceiling - FLOOR).toBeCloseTo(19.0, 1);
    // It came in from 27rem, and every pixel of that went to the stage.
    expect(27 * REM - ceiling).toBe(80);
  });
});

describe('how tall the row is, and how many routes that holds', () => {
  /*
   * A row is Remove's height rather than the route button's 35.4 — `small` is
   * 0.8rem over a 1.5 line-height inside `--space-1 * 1.25` and a border — and
   * the report line under it is always in the document, so `.item`'s 2px gap
   * is spent whether or not there is anything to report.
   */
  const ROW = 0.8 * REM * 1.5 + 2 * (REM * 0.25 * 1.25) + 2 + 2;
  /** `.list`'s own `--space-1` between rows. */
  const BETWEEN = REM * 0.25;

  /*
   * What the watchlist spends above its scroller that the map does not spend
   * above its stage: a head, its margin and the panel's gap (68.5), then the
   * add form, its rule and another gap, against the map's toolbar and its 8px
   * column gap (51.4).
   *
   * The form was 139 and is 232.6, and the 93.6 is the month strip's doing —
   * every pixel of it declared in `RouteEditor.module.css`:
   *
   * - two rows of chips at `2px` padding, a `1px` border and 0.66rem over a
   *   1.35 line-height, with `--space-1` between them: 2 × 23.82 + 5 = 52.64;
   * - the line saying what those months cost a pass, 0.7rem over the 1.5 this
   *   app's paragraphs carry: 21;
   * - the form's own `--space-2` row gap, twice, because the strip and the cost
   *   line are two rows the form did not have: 20.
   *
   * The warnings under them are `display: none` while there is nothing to warn
   * about, so they take neither a row nor a gap on the ordinary path.
   */
  const ADD_FORM = 139 + 52.64 + 21 + 20;
  const ABOVE_THE_SCROLLER = 68.5 + ADD_FORM - 51.4;

  const stage = (): number => pixels(rule('stage', MAP), 'min-height');

  function rowsThatFit(height: number): number {
    return Math.floor((height - ABOVE_THE_SCROLLER + BETWEEN) / (ROW + BETWEEN));
  }

  it('holds ten watched routes without a scrollbar', () => {
    /*
     * The owner's ask, in one number: "habilitar espacio para mas rutas y
     * evitar por el momento el uso de barra de desplazamiento".
     *
     * The stage grew from 640 to 710 to keep it at ten. That 70px is what the
     * month strip costs the map, and it is the visible price of picking twelve
     * months in one place instead of one month at a time — `a-taller-row-is-
     * four-more-routes` said ten rows is the number worth paying for, and this
     * is that decision holding under a taller form rather than being quietly
     * renegotiated down to eight.
     */
    expect(stage()).toBe(710);
    expect(rowsThatFit(stage())).toBe(10);
  });

  it('would have held eight at the old stage, which is what the strip cost', () => {
    // Written down rather than left implicit: the same 640px the map had
    // before this change now holds eight rows, and the 70px above is exactly
    // what buys the other two back.
    expect(rowsThatFit(640)).toBe(8);
  });

  it('brings the scrollbar back at eleven, and says where rather than pretending', () => {
    /*
     * "Por el momento" is the owner's own qualifier. The list is still a
     * scroller with the same edge shadows, and this pins where it starts
     * scrolling again, so a watchlist that outgrows the box does it at a
     * number somebody chose.
     */
    const scroller = stage() - ABOVE_THE_SCROLLER;
    expect(11 * ROW + 10 * BETWEEN).toBeGreaterThan(scroller);
    expect(10 * ROW + 9 * BETWEEN).toBeLessThan(scroller);
  });

  it('leaves the map and the watchlist one height, and it is the stage that carries it', () => {
    /*
     * There is no second height to keep in step. The watchlist is sized as if
     * it were empty, so the row is whatever the stage says — which is why a
     * taller list is spelled as a `min-height` on the map's stage and nowhere
     * else, and why the list's own boxes must go on declaring a floor of zero.
     */
    expect(rule('top', PAGE)).toMatch(/align-items:\s*stretch/);
    expect(rule('listBox', LIST)).toMatch(/contain:\s*var\(--airfare-routes-contain/);
    expect(rule('listBox', LIST)).toMatch(/min-height:\s*0/);
    expect(rule('list', LIST)).toMatch(/min-height:\s*0/);
  });
});
