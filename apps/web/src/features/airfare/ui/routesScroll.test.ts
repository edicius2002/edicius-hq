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
    expect(LIST).not.toMatch(/@media[^{]*width/);
    expect(LIST).not.toContain('1080');
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
  /*
   * The route button's own content, at the 7px gaps `.route` and `.dates`
   * declare: a swatch, the pair, and one leg carrying the longest month this
   * list can print — `September 2027`, since 12.110 made the leg a month and
   * 12.113 took the second one away.
   */
  const SWATCH = 8;
  const PAIR = 4 * advance(0.78) + advance(0.62) + 4 * advance(0.78);
  const LEG = advance(0.7) + 2 + 'September 2027'.length * advance(0.66);
  const GAPS_IN_ROUTE = 7 + 7;

  /** The route button's own padding, `--space-2` either side, and its border. */
  const ROUTE_CHROME = 2 * (REM * 0.5) + 2;
  /** `Remove`, a `small` ghost button: six advances inside the same chrome. */
  const REMOVE = 'Remove'.length * advance(0.8) + 2 * (REM * 0.5) + 2;
  /** The collect mark, 12px inside that chrome. */
  const COLLECT = 12 + 2 * (REM * 0.5) + 2;
  /** `.row`'s own `--space-2` between its children. */
  const BESIDE = REM * 0.5;

  /** A row still being watched: the route, the collect mark, Remove. */
  const WATCHED =
    SWATCH + GAPS_IN_ROUTE + PAIR + LEG + ROUTE_CHROME + COLLECT + REMOVE + 2 * BESIDE;

  /*
   * A departed row, which is the wider of the two and so the floor. It loses
   * the collect control and a gap, but `Departed` is a fourth child of a
   * three-track grid: it wraps under the swatch and widens that `auto` track
   * from 8px to its own eight advances.
   */
  const DEPARTED =
    'Departed'.length * advance(0.65) + GAPS_IN_ROUTE + PAIR + LEG + ROUTE_CHROME + REMOVE + BESIDE;

  const FLOOR = Math.max(WATCHED, DEPARTED) + PANEL_CHROME;

  it('is the departed row that sets the floor, not the watched one', () => {
    // Worth pinning, because the intuition runs the other way: dropping a
    // control ought to give room back, and here it costs 10.4px more.
    expect(DEPARTED).toBeGreaterThan(WATCHED);
    expect(FLOOR).toBeCloseTo(433.6, 1);
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
    expect(ceiling, 'the column ceiling must fit it too').toBeGreaterThanOrEqual(FLOOR);
  });

  it('is as narrow as that floor allows and no narrower, so the map has the rest', () => {
    /*
     * The owner asked for the map to grow to the right and the watchlist to
     * come in, and the map's track is `1fr` — so this number is the map's
     * width as much as it is the list's. 23rem leaves 26.4px on the binding
     * row; a rem further in is 440px, which clears the floor by 6.4 and is not
     * a margin at all once a face or a token moves.
     */
    const { ceiling } = column();
    expect(ceiling).toBe(23 * REM);
    expect(ceiling - FLOOR).toBeCloseTo(26.4, 1);
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
   * add form, its rule and another gap (139), against the map's toolbar and
   * its 8px column gap (51.4).
   */
  const ABOVE_THE_SCROLLER = 68.5 + 139 - 51.4;

  const stage = (): number => pixels(rule('stage', MAP), 'min-height');

  function rowsThatFit(height: number): number {
    return Math.floor((height - ABOVE_THE_SCROLLER + BETWEEN) / (ROW + BETWEEN));
  }

  it('holds ten watched routes without a scrollbar', () => {
    // The owner's ask, in one number: "habilitar espacio para mas rutas y
    // evitar por el momento el uso de barra de desplazamiento".
    expect(stage()).toBe(640);
    expect(rowsThatFit(stage())).toBe(10);
  });

  it('held six before, which is exactly what the reader had watched', () => {
    // Why there was a scrollbar to complain about: six routes, six rows of
    // room, and a seventh 9.6px short of fitting.
    expect(rowsThatFit(460)).toBe(6);
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
