import { describe, expect, it } from 'vitest';

import TOKENS_SOURCE from '@/styles/tokens.css?inline';

import CSS_SOURCE from './InvestingPage.module.css?inline';

/**
 * The one thing about this layout that jsdom cannot see, checked by reading the
 * stylesheet instead.
 *
 * jsdom lays nothing out and evaluates no container query, so every test that
 * renders this page passes whether the two columns apply at 980px, at 1160px,
 * or never. They applied never: the breakpoint was written `58rem` in the
 * belief that a rem is 16px, but a font-relative length in a container
 * condition resolves against the root, and this app sets
 * `--font-size-base: 125%` — so it read 1160px, the usable page is 1141px wide
 * on a 1536px window, and the side-by-side layout the file is built around was
 * unreachable. Nothing went red. The page just quietly looked the way it had
 * before.
 *
 * So the numbers are checked against each other here: the threshold has to be
 * the sum of the widths it was derived from, all of them read from the same
 * stylesheets that will be shipped, and it has to be written in a unit that
 * cannot be read two ways. Class names are matched through the `_local_hash`
 * shape the compiler gives them — the hash differs between the two ways this
 * file can be imported, so it is the local name that identifies a rule, and a
 * renamed class fails loudly rather than silently matching nothing.
 */

/**
 * Comments come out first, and this matters: the prose in that stylesheet
 * quotes several of the very lengths being matched for, and a regex cannot
 * tell an explanation from a declaration.
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

/** The body of a rule, found by the local class name the source declares. */
function rule(local: string, from: string = CSS): string {
  const found = new RegExp(`\\._${local}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(from);
  expect(found, `.${local} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

function token(name: string): number {
  const value = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(TOKENS);
  expect(value, `--${name} must be a rem token`).not.toBeNull();
  return Number(value?.[1]) * REM_PX;
}

/** The `@container` block whose body contains `needle`, and its condition. */
function containerQuery(needle: string): { condition: string; body: string } {
  for (const match of CSS.matchAll(/@container ([^{]+)\{([\s\S]*?)\n\}/g)) {
    if (match[2].includes(needle)) return { condition: match[1].trim(), body: match[2] };
  }
  throw new Error(`no @container block mentions ${needle}`);
}

const stacked = () => containerQuery('_workspace_');

describe('the width at which the chart and the watchlist stop sharing a row', () => {
  it('is the sum of the widths it is derived from', () => {
    const workspace = rule('workspace');

    // `minmax(0, 1fr) minmax(15rem, 16rem)`: the side column takes its ceiling
    // whenever the row is wide enough to give it, so the ceiling is the case
    // that has to fit.
    const side = /minmax\(\s*[\d.]+rem\s*,\s*([\d.]+)rem\s*\)/.exec(workspace);
    expect(side, 'the workspace must size its side column with a minmax').not.toBeNull();
    const sideWidth = Number(side?.[1]) * REM_PX;

    const gapToken = /gap:\s*var\(--(space-\d)\)/.exec(workspace)?.[1] ?? '';
    const gap = token(gapToken);

    // The chart is what the page is for, so it keeps at least twice what the
    // list beside it takes.
    const chartFloor = sideWidth * 2;

    const threshold = Number(/max-width:\s*(\d+)px/.exec(stacked().condition)?.[1] ?? NaN);

    expect(REM_PX).toBe(20);
    expect(sideWidth).toBe(320);
    expect(gap).toBe(20);
    expect(chartFloor).toBe(640);
    expect(threshold).toBe(chartFloor + gap + sideWidth);
  });

  it('is written in pixels, because a rem in a container query is not the rem you meant', () => {
    const conditions = [...CSS.matchAll(/@container ([^{]+)\{/g)].map((match) => match[1]);

    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition).not.toMatch(/rem/);
      expect(condition).toMatch(/\d+px/);
    }
  });

  it('leaves the watchlist the full width once the two are stacked', () => {
    // It was capped at 36rem and pushed to the right, inherited from the
    // wrapper this panel replaced — which read as a half-width panel hugging
    // the right edge of a full-width page. Checked across the whole block
    // rather than one rule, because either declaration would do it again from
    // anywhere in here.
    expect(stacked().body).not.toMatch(/width:|justify-self:/);
  });
});

describe('the mechanisms the shared height depends on', () => {
  it('stretches the row so both panels reach the same height', () => {
    // `start` would let each panel end at its own content, which is the ragged
    // gap this layout exists to remove.
    expect(rule('workspace')).toMatch(/align-items:\s*stretch/);
  });

  it('sizes the rows as if they were empty, so a long list cannot grow the row', () => {
    const scroller = rule('scroller');

    // The load-bearing one. A growable flex item contributes all of its
    // content to its container's intrinsic height whatever its basis, and a
    // scroll container's max-content size is its content too — so without size
    // containment a watchlist longer than the chart pushes the row taller and
    // leaves the chart panel with a gap under it. `flex: 1 1 0` is what then
    // spends the height the chart settled on.
    expect(scroller).toMatch(/contain:\s*size/);
    expect(scroller).toMatch(/flex:\s*1 1 0/);
    expect(scroller).toMatch(/min-height:\s*0/);
    expect(scroller).toMatch(/overflow-y:\s*auto/);
  });

  it('hands the height back to the rows where there is no row to share', () => {
    const scroller = rule('scroller', stacked().body);

    // Stacked, nothing above it has a height to give, and a box sized as if it
    // were empty inside a box of no height is a box of no height — the list
    // would disappear instead of scrolling. So containment comes off and the
    // rows size themselves up to a ceiling.
    expect(scroller).toMatch(/contain:\s*none/);
    expect(scroller).toMatch(/flex:\s*0 1 auto/);
    expect(scroller).toMatch(/max-height:\s*[\d.]+rem/);
  });
});
