import { describe, expect, it } from 'vitest';

import PAGE_SOURCE from './AirfarePage.module.css?inline';
import LIST_SOURCE from './RouteList.module.css?inline';

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
