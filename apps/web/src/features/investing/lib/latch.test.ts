import { describe, expect, it } from 'vitest';

import { FALL_GRACE_MS, latch } from '@/features/investing/lib/latch';

describe('latch', () => {
  it('rises the moment it is told to', () => {
    // Coming back is good news and there is no reason to delay it.
    expect(latch(false).raise().value).toBe(true);
  });

  it('does not fall on the first ask', () => {
    const dropped = latch(true).lower(0);

    expect(dropped.value).toBe(true);
  });

  it('falls once the grace has passed', () => {
    const dropped = latch(true).lower(0);

    expect(dropped.settle(FALL_GRACE_MS - 1).value).toBe(true);
    expect(dropped.settle(FALL_GRACE_MS).value).toBe(false);
  });

  it('a reconnect inside the grace leaves it up, with no trace of the dip', () => {
    /*
     * This is the whole point. A stream that ends and reconnects three seconds
     * later must not toggle the value that selects the sweep interval —
     * TanStack rebuilds the refetch timer on every change, so a value flipping
     * faster than the interval it picks means the timer never fires and the
     * sweep stops.
     */
    const recovered = latch(true).lower(0).raise();

    expect(recovered.value).toBe(true);
    expect(recovered.settle(FALL_GRACE_MS * 10).value).toBe(true);
  });

  it('survives a run of flaps without ever going down', () => {
    let it_ = latch(true);
    for (let t = 0; t < 10; t += 1) {
      it_ = it_
        .lower(t * 3_000)
        .settle(t * 3_000 + 1)
        .raise();
    }

    expect(it_.value).toBe(true);
  });

  it('does report a real outage', () => {
    // Falling slowly must not mean never falling.
    const out = latch(true)
      .lower(0)
      .settle(FALL_GRACE_MS + 1);

    expect(out.value).toBe(false);
  });

  it('lowering something already down changes nothing', () => {
    const down = latch(false);

    expect(down.lower(0).value).toBe(false);
    expect(down.lower(0).settle(FALL_GRACE_MS * 5).value).toBe(false);
  });

  it('keeps the first fall time rather than restarting the clock', () => {
    // Otherwise a source that asks to fall repeatedly would postpone it
    // forever, which is the opposite failure.
    const asked = latch(true)
      .lower(0)
      .lower(FALL_GRACE_MS - 1);

    expect(asked.settle(FALL_GRACE_MS).value).toBe(false);
  });
});
