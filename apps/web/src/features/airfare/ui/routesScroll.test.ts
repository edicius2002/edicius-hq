import { describe, expect, it } from 'vitest';

import PAGE_SOURCE from './AirfarePage.module.css?inline';
import EDITOR_SOURCE from './RouteEditor.module.css?inline';
import DETAIL_SOURCE from './RouteDetail.module.css?inline';
import LIST_SOURCE from './RouteList.module.css?inline';
import MAP_SOURCE from './RouteMap.module.css?inline';

/* jsdom does not lay out grids or implement size containment, so these tests
 * hold the measured CSS contract that browser rendering depends on. */
const clean = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const PAGE = clean(PAGE_SOURCE);
const EDITOR = clean(EDITOR_SOURCE);
const DETAIL = clean(DETAIL_SOURCE);
const LIST = clean(LIST_SOURCE);
const MAP = clean(MAP_SOURCE);

function rule(local: string, from: string): string {
  const found = new RegExp(`\\._${local}_[0-9a-z]+\\s*\\{([^}]*)\\}`).exec(from);
  expect(found, `.${local} must have a rule`).not.toBeNull();
  return found?.[1] ?? '';
}

function media(source: string, query: string): string {
  const start = source.indexOf(`@media ${query}`);
  expect(start, `${query} must exist`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1;
    if (source[at] === '}' && --depth === 0) return source.slice(open + 1, at);
  }
  throw new Error(`${query} is not closed`);
}

function tracks(viewport: number): number[] {
  const declaration = rule(
    'top',
    viewport <= 900 ? media(PAGE, '(min-width: 641px) and (max-width: 900px)') : PAGE,
  );
  const columns = /grid-template-columns:\s*([^;]+);/.exec(declaration)?.[1] ?? '';
  // Each track is `minmax(<floor>, <share>fr)`, the floor either 0 or in rem.
  const parsed = [...columns.matchAll(/minmax\((0|[\d.]+rem),\s*([\d.]+)fr\)/g)].map(
    ([, floor, share]) => ({
      // The app's 125% root makes 1rem 20px.
      floor: floor === '0' ? 0 : Number.parseFloat(floor) * 20,
      share: Number(share),
    }),
  );
  expect(parsed, 'the desktop row must have three fractional tracks').toHaveLength(3);
  // AppShell spends 40px on each side and .top has two 30px gaps.
  const available = viewport - 80 - 60;
  // The grid's own rule: a track whose share falls under its floor is frozen
  // at the floor, and the rest is shared again among the tracks still flexing.
  const frozen = new Set<number>();
  for (;;) {
    const left = available - [...frozen].reduce((sum, at) => sum + parsed[at].floor, 0);
    const shares = parsed.reduce((sum, track, at) => (frozen.has(at) ? sum : sum + track.share), 0);
    const widths = parsed.map((track, at) =>
      frozen.has(at) ? track.floor : (left * track.share) / shares,
    );
    const under = widths.findIndex((width, at) => !frozen.has(at) && width < parsed[at].floor);
    if (under === -1) return widths;
    frozen.add(under);
  }
}

describe('the three-panel airfare row', () => {
  it('uses the map stage for a 520px row', () => {
    const stage = Number(/min-height:\s*(\d+)px/.exec(rule('stage', MAP))?.[1]);
    const panelPadding = /padding:\s*var\(--space-3\)/.test(PAGE) ? 15 : 20;
    expect(stage + panelPadding * 2 + 2).toBe(520);
    expect(rule('top', PAGE)).toMatch(/align-items:\s*stretch/);
  });

  it.each([
    [1518, 492, 630, 256],
    [1300, 399, 511, 250],
    [1080, 303, 387, 250],
    [800, 197, 236, 227],
    [641, 150, 179, 172],
  ])('resolves three tracks at %ipx', (viewport, map, routes, details) => {
    const widths = tracks(viewport);
    expect(widths).toHaveLength(3);
    expect(widths[0]).toBeCloseTo(map, 0);
    expect(widths[1]).toBeCloseTo(routes, 0);
    expect(widths[2]).toBeCloseTo(details, 0);
  });

  it('keeps size containment until the phone stack', () => {
    const top = rule('top', PAGE);
    expect(top).toMatch(/--airfare-routes-contain:\s*size/);
    expect(top).toMatch(/--airfare-routes-flex:\s*1 1 0/);
    expect(top).toMatch(/--airfare-routes-cap:\s*none/);
    const box = rule('listBox', LIST);
    expect(box).toMatch(/contain:\s*var\(--airfare-routes-contain/);
    expect(box).toMatch(/min-height:\s*0/);
    expect(rule('list', LIST)).toMatch(/overflow-y:\s*auto/);
    expect(rule('list', LIST)).toMatch(/min-height:\s*0/);
    expect(PAGE).not.toContain('@media (max-width: 1080px)');
    const phone = media(PAGE, '(max-width: 640px)');
    expect(phone).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(phone).toMatch(/--airfare-routes-contain:\s*none/);
    expect(phone).toMatch(/--airfare-routes-flex:\s*0 1 auto/);
  });

  it('fits four months inside the narrowest desktop route and form tracks', () => {
    const narrowList = media(LIST, '(min-width: 641px) and (max-width: 1400px)');
    const narrowForm = media(EDITOR, '(min-width: 641px) and (max-width: 1400px)');
    expect(narrowList).toMatch(/grid-template-columns:\s*repeat\(4, auto\)/);
    expect(narrowForm).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    // The 641px edge still leaves enough for four tabs after 15px gutters.
    const content = tracks(641)[1] - 32;
    const fourRowTabs = 4 * (3 * (0.66 * 20 * 0.6) + 6 + 2) + 3 * 3;
    const fourFormChips = 4 * (3 * (0.66 * 20 * 0.6) + 4 + 2) + 3 * 5;
    expect(content).toBeGreaterThan(fourRowTabs);
    expect(content).toBeGreaterThan(fourFormChips);
    expect(narrowList).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(narrowForm).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  });

  it('stacks the detail vertically and compacts only its figures on phones', () => {
    expect(rule('detail', DETAIL)).toMatch(/flex-direction:\s*column/);
    expect(rule('figures', DETAIL)).toMatch(
      /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    );
    const phone = media(DETAIL, '(max-width: 640px)');
    expect(phone).toMatch(/min-height:\s*0/);
    expect(phone).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  });
});
