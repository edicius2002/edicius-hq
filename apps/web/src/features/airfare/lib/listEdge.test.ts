import { describe, expect, it } from 'vitest';

import { listEdge } from '@/features/airfare/lib/listEdge';

/** A list 300px tall holding 800px of rows, unless said otherwise. */
function box(scrollTop: number, clientHeight = 300, scrollHeight = 800) {
  return { scrollTop, clientHeight, scrollHeight };
}

describe('which ends of a scrolling list have more beyond them', () => {
  it('says nothing at all when every row already fits', () => {
    // The common case, and the one that must not draw a mark: three routes in
    // a panel with room for ten is not a list with anything hidden.
    expect(listEdge(box(0, 300, 300))).toBe('none');
    expect(listEdge(box(0, 300, 120))).toBe('none');
  });

  it('says there is more below while the list sits at its top', () => {
    expect(listEdge(box(0))).toBe('below');
  });

  it('says there is more both ways in the middle', () => {
    expect(listEdge(box(200))).toBe('both');
  });

  it('says only above once the last row is on screen', () => {
    // The half that a shadow painted unconditionally gets wrong: at the bottom
    // there is nothing below, and a mark still sitting there is the page
    // claiming rows it does not have.
    expect(listEdge(box(500))).toBe('above');
  });

  it('treats a rounding error at either end as the end', () => {
    /*
     * These are fractional. A 300.5px box scrolled to its end reports a
     * `scrollTop` that misses `scrollHeight - clientHeight` by less than a
     * pixel, and a mark that never quite switches off is the same lie as one
     * that is always on. The same slack at the top, for the same reason.
     */
    expect(listEdge(box(0.4))).toBe('below');
    expect(listEdge(box(499.6))).toBe('above');
    expect(listEdge(box(0.4, 300.5, 800))).toBe('below');
  });

  it('reads an overscrolled box as the end rather than as nonsense', () => {
    // Elastic scrolling and a list that shrank under a reader who was part way
    // down both produce this, and neither is a reason to draw a mark for rows
    // that are not there.
    expect(listEdge(box(900))).toBe('above');
    expect(listEdge(box(-20))).toBe('below');
  });
});
