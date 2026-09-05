import { useSyncExternalStore } from 'react';

/**
 * Where the shell stops being able to hold its top row.
 *
 * **In pixels on purpose, and the number is derived rather than chosen.**
 * `--font-size-base: 125%` makes a rem 20px here, so a rem in a media
 * condition reads a quarter wider than it looks — the same trap
 * `InvestingPage.module.css` documents at length for its container queries.
 *
 * The row is `brand + status`, the page title and the trigger, none of which
 * can shrink past their own `min-content`. Measured in a 360px viewport it
 * asks for 474px on Dashboard and 485px on Greenlight, the widest of the five,
 * against the 345px it is given — which is how the trigger ended up off screen
 * on every page. 640 clears the worst of those by 155px, leaving room for a
 * page title longer than any of today's, and sits under the 740px a phone
 * gives in landscape, where the row genuinely fits and the dropdown is still
 * the better control.
 *
 * Retune by measuring the row, not by reasoning about it: render the five
 * routes at the width you are considering and compare `header.scrollWidth`
 * against its `clientWidth`.
 */
export const NARROW_QUERY = '(max-width: 640px)';

/**
 * Whether the shell should use its narrow navigation.
 *
 * The decision is made in JavaScript rather than by rendering both branches
 * and hiding one, because both are landmarks: two `nav`s named "Primary" in
 * one tree is an ambiguity for anything reading the page, tests included.
 *
 * jsdom answers `false` to any width — it lays nothing out — so a suite that
 * says nothing keeps seeing the wide branch, and a test that wants the other
 * one stubs `matchMedia`. That is deliberate: it leaves the existing shell
 * tests measuring what they already measured.
 */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribe, matchNarrow);
}

/**
 * The viewport is an external store, so it is read as one.
 *
 * `useSyncExternalStore` rather than state kept in sync from an effect: it
 * re-reads the snapshot at the moment it subscribes, which is the race an
 * effect has to paper over by setting state as its first act — the viewport
 * can cross the threshold between the first render and the subscription, and
 * the initial read is a guess about a browser that has not painted yet.
 */
function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function matchNarrow(): boolean {
  // `window` is present in every environment this app runs in, but
  // `matchMedia` is not — `RouteMap` guards its own call the same way. Wide is
  // the safe answer: it is the branch whose navigation needs no gesture.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}
