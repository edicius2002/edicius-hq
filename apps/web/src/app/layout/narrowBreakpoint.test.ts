import { describe, expect, it } from 'vitest';

import { NARROW_QUERY } from '@/app/layout/useIsNarrow';
import FINANCE_SOURCE from '@/features/finance/ui/FinancePage.module.css?inline';
import TOKENS_SOURCE from '@/styles/tokens.css?inline';

/**
 * The narrow threshold lives in two places that cannot see each other, and
 * this is the seam between them.
 *
 * `useIsNarrow` decides in JavaScript whether the shell shows a drawer or a
 * dropdown. `FinancePage.module.css` decides in CSS whether that page's header
 * controls are at phone scale. They have to agree: a viewport between the two
 * numbers gets one page's answer and the other page's layout — a Finance
 * header still at desktop scale under a shell that has already given up its
 * top row, or the reverse. Nothing renders wrong enough to fail a test that
 * only looks at one of them, because jsdom evaluates neither.
 *
 * This is the same failure the `?inline` tests in this repo already cover for
 * one stylesheet against another; the only new thing is that one side of the
 * arithmetic is a TypeScript constant.
 */

/**
 * Comments first, and it matters here as much as anywhere: both files explain
 * the number in prose right beside it, and a regex cannot tell an explanation
 * from a declaration.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const FINANCE = withoutComments(FINANCE_SOURCE);
const TOKENS = withoutComments(TOKENS_SOURCE);

/** What one rem is worth here, taken from the token rather than assumed. */
const REM_PX = (() => {
  const percent = /--font-size-base:\s*([\d.]+)%/.exec(TOKENS);
  expect(percent, 'tokens.css must state a base font size').not.toBeNull();
  return (16 * Number(percent?.[1])) / 100;
})();

/**
 * What the shell's top row asks for, measured rather than reasoned about.
 *
 * A 360px viewport at this type scale leaves the header 345px. Its children —
 * the brand block with the API status, the page title and the trigger — are
 * `flex: 0 1 auto` with `min-width: auto`, so none of them shrinks past its
 * own text, and the row's `min-content` came to 474px on Dashboard and 485px
 * on Greenlight, the widest of the five routes. The trigger sat at x=396 on a
 * 360px screen: off it.
 *
 * Re-measure by rendering the five routes and comparing the header's
 * `scrollWidth` against its `clientWidth`; do not re-derive it from these
 * numbers, because they are an observation of one type scale.
 */
const WIDEST_MEASURED_ROW = 485;

const threshold = Number(/max-width:\s*(\d+)px/.exec(NARROW_QUERY)?.[1] ?? NaN);

describe('the width at which the shell hands its navigation to a drawer', () => {
  it('is written in pixels, because a rem here is not the rem you meant', () => {
    // `--font-size-base: 125%` makes a rem 20px, so `40rem` would read 800px
    // rather than 640. The same trap cost this repo its Investing breakpoint;
    // see `workspaceBreakpoint.test`.
    expect(REM_PX).toBe(20);
    expect(NARROW_QUERY).not.toMatch(/rem/);
    expect(NARROW_QUERY).toMatch(/\d+px/);
  });

  it('clears the widest row that has to fit above it', () => {
    expect(threshold).toBeGreaterThan(WIDEST_MEASURED_ROW);
  });

  it('stays under the width a phone gives in landscape, where the row fits', () => {
    // 740x360 is a 360px phone turned sideways. The row needs 485px, so the
    // dropdown is still reachable there and is the better control for it —
    // a drawer would cost most of a 360px-tall viewport to show five links.
    expect(threshold).toBeLessThan(740);
  });

  it('is the same number the Finance header scales its controls at', () => {
    const financeThresholds = [...FINANCE.matchAll(/@media \(max-width:\s*(\d+)px\)/g)].map(
      (match) => Number(match[1]),
    );

    expect(financeThresholds, 'FinancePage must scale its header somewhere').toContain(threshold);
  });

  /*
   * This assertion used to run the other way — no `wrap` in the narrow block,
   * guarding the note at the top of `FinancePage.module.css` that wrapping
   * moves the canvas down a row. That note governs desktop, where the row
   * holds. At 360px it does not: `.toolbar` wraps inside the `nowrap` header
   * anyway, so the header was seven rows and 304px tall with the tab strip
   * squeezed to 76px — narrower than one tab. Wrapping was chosen there
   * deliberately, and `order: 1` is what keeps the cost on the tabs rather
   * than on the canvas. Checked so the pair cannot drift apart.
   */
  it('moves the Finance tab strip below the actions rather than above them', () => {
    const narrowBlock = /@media \(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/.exec(FINANCE)?.[1] ?? '';

    expect(narrowBlock, 'the 640px block must exist to be checked').not.toBe('');
    expect(narrowBlock).toMatch(/flex-wrap:\s*wrap/);
    // Without the order the strip takes the first line and the canvas is what
    // moves down — the exact regression the desktop rule exists to prevent.
    expect(narrowBlock).toMatch(/order:\s*1/);
    expect(narrowBlock).toMatch(/flex-basis:\s*100%/);
  });

  it('keeps the Finance header on one line above the threshold', () => {
    // The desktop rule is untouched and stays that way: `nowrap` is declared
    // outside any media query, and only the narrow block may reverse it.
    const base = FINANCE.split('@media')[0];

    expect(base).toMatch(/flex-wrap:\s*nowrap/);
  });
});
