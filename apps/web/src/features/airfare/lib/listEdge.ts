/**
 * Which ends of a scrolling list have more beyond them — 12.259.
 *
 * A list that stops at a clean edge reads as the end of the list, and the
 * watchlist's rows are opaque cards on their own background, so the usual
 * CSS-only answer — a shadow painted on the scroll container's background,
 * covered at each end by a `background-attachment: local` gradient — is
 * invisible here: it paints *behind* the rows. The mark has to be drawn in
 * front of them, and nothing in CSS can put an overlay in front of content and
 * know the scroll position at the same time. `animation-timeline: scroll()`
 * can, and is refused for the reason this repository refuses most clever
 * fallbacks: where it is unsupported the animation simply never runs, so the
 * mark either never appears or never goes away, and both of those are the page
 * lying about what is there.
 *
 * So the scroll position is read, and the reading is this function: three
 * numbers in, one word out, so the rule is a unit test rather than a browser.
 * The component's job is only to call it and put the answer in an attribute.
 *
 * The tolerance is a pixel because these are fractional. A container 240.5px
 * tall scrolled to its end reports a `scrollTop` that misses `scrollHeight -
 * clientHeight` by a rounding error, and a shadow that never quite switches
 * off at the bottom is the same lie as one that is always on.
 */
export type ListEdge = 'none' | 'above' | 'below' | 'both';

/** Subpixel slack, in CSS pixels. */
const EPSILON = 1;

export function listEdge(box: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): ListEdge {
  const above = box.scrollTop > EPSILON;
  const below = box.scrollTop + box.clientHeight < box.scrollHeight - EPSILON;
  if (above && below) return 'both';
  if (above) return 'above';
  if (below) return 'below';
  return 'none';
}
