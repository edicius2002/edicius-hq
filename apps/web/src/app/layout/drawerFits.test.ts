import { describe, expect, it } from 'vitest';

import ENROL_SOURCE from '@/features/auth/EnrolDevice.module.css?inline';
import NAV_SOURCE from '@/app/layout/TopNav.module.css?inline';
import TOKENS_SOURCE from '@/styles/tokens.css?inline';

/**
 * Whether what the drawer holds fits the drawer.
 *
 * The narrow navigation is a fixed width and the dropdown it replaces is not,
 * and `EnrolDevice` is rendered in both. It carries `min-width: 15rem` because
 * the dropdown is absolutely positioned and shrink-to-fit, and would jump width
 * the moment a code appeared inside it. The drawer has no such problem and no
 * such room, so that floor overflowed it — and because `overflow-y: auto` makes
 * the other axis compute to `auto` rather than stay `visible`, the overflow
 * arrived as a horizontal scrollbar nobody asked for.
 *
 * Measured in a 390px viewport: 304px of drawer, 274px inside its padding, and
 * a 300px floor in the middle of it. jsdom lays out none of that, and the
 * numbers live in three stylesheets that do not import one another, so this
 * reads them as text the way `routesScroll` and `narrowBreakpoint` do.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const NAV = withoutComments(NAV_SOURCE);
const ENROL = withoutComments(ENROL_SOURCE);
const TOKENS = withoutComments(TOKENS_SOURCE);

/** What one rem is worth here, taken from the token rather than assumed. */
const REM_PX = (() => {
  const percent = /--font-size-base:\s*([\d.]+)%/.exec(TOKENS);
  expect(percent, 'tokens.css must state a base font size').not.toBeNull();
  return (16 * Number(percent?.[1])) / 100;
})();

function tokenPx(name: string): number {
  const rem = new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(TOKENS);
  expect(rem, `tokens.css must define --${name}`).not.toBeNull();
  return Number(rem?.[1]) * REM_PX;
}

/**
 * The narrowest screen this is held to.
 *
 * 320px is the floor a phone layout is usually taken to — narrower than the
 * 360px and 390px the drawer was measured on, and the width at which its 78vw
 * leaves the least room for what it holds.
 */
const NARROWEST_PHONE = 320;

/*
 * Class names arrive hashed — `.drawer` reads `._drawer_7a2e0f` in the compiled
 * text — so every selector below is matched by its stem rather than by the name
 * it is written as. The hash changes whenever the file does.
 */
function rule(source: string, selector: string): string {
  return new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
}

const DRAWER = String.raw`\._drawer_\w+`;
const ACCOUNT = String.raw`\._account_\w+`;

const drawerBlock = rule(NAV, DRAWER);
const enrolBlock = rule(ENROL, String.raw`\._enrol_\w+`);

describe('what the narrow drawer holds', () => {
  it('is scrolled vertically, which is what puts a horizontal axis in play', () => {
    // Not decoration: per CSS, an `overflow` axis that is not `visible` makes
    // the other compute to `auto`. The drawer asks for vertical scrolling, so
    // it is asking for horizontal scrolling too, and anything that does not fit
    // arrives as a bar rather than as a spill somebody would notice.
    expect(drawerBlock, 'the drawer rule must exist to be checked').not.toBe('');
    expect(drawerBlock).toMatch(/overflow-y:\s*auto/);
  });

  it('has less room across than the enrol block asks for on its own', () => {
    const vw = /width:\s*min\([\d.]+rem,\s*([\d.]+)vw\)/.exec(drawerBlock);
    expect(vw, 'the drawer must size itself against the viewport').not.toBeNull();

    const drawerWidth = (Number(vw?.[1]) / 100) * NARROWEST_PHONE;
    const contentWidth = drawerWidth - tokenPx('space-3') * 2;

    const floor = /min-width:\s*([\d.]+)rem/.exec(enrolBlock);
    expect(floor, 'EnrolDevice must state the floor this is about').not.toBeNull();
    const enrolFloor = Number(floor?.[1]) * REM_PX;

    // The whole reason the override below exists. If this ever stops being
    // true — a lower floor, a wider drawer — the override is dead weight and
    // should go rather than be kept because a test passed either way.
    expect(enrolFloor).toBeGreaterThan(contentWidth);
  });

  it('lets that block shrink to the drawer rather than overflow it', () => {
    const override = rule(NAV, String.raw`${DRAWER}\s+${ACCOUNT}\s*>\s*\*`);

    expect(override, 'the drawer must neutralise the dropdown floor').not.toBe('');
    expect(override).toMatch(/min-width:\s*0/);
    expect(override).toMatch(/max-width:\s*100%/);
  });

  it('fixes the width rather than hiding what does not fit', () => {
    // `overflow-x: hidden` would leave the block exactly as wide and only stop
    // it being reachable, which is worse than the scrollbar: the enrol button
    // would be cut off with nothing to say so.
    expect(drawerBlock).not.toMatch(/overflow-x:\s*hidden/);
  });

  it('drops the negative margin the dropdown insets by, which the drawer does not', () => {
    // `.account` pulls 5px wider than its box so its rule runs past the inset
    // on the dropdown's links. The drawer insets by `--space-3`, so the same
    // pull lines up with nothing and only pushes the block past the edge.
    const account = rule(NAV, String.raw`${DRAWER}\s+${ACCOUNT}`);

    expect(account, 'the drawer must restate the account margin').not.toBe('');
    expect(account).toMatch(/margin-inline:\s*0/);
  });
});
