/**
 * A boolean that rises at once and falls slowly.
 *
 * `live` decides how often the page sweeps: 60s against 15s while the market is
 * open, 5 minutes against 60s in extended hours. TanStack recreates the refetch
 * timer whenever that interval changes, so a value that flips faster than the
 * interval it selects means the timer is rebuilt before it ever fires — and the
 * sweep, which decision 8.18 makes the source of truth, silently stops.
 *
 * That is not hypothetical. Before the heartbeat was fixed, the stream ended
 * every twenty seconds of quiet and reconnected about three seconds later, so
 * `live` oscillated on roughly that period while selecting intervals of 15 and
 * 60 seconds. Neither was ever reached.
 *
 * The heartbeat fix removes the cause. This removes the class: any future
 * source of flapping — a flaky network, a proxy with its own idea of an idle
 * connection — cannot starve the timer, because falling costs a grace period
 * and rising does not.
 */

/** Long enough to outlast a reconnect, short enough to notice a real outage. */
export const FALL_GRACE_MS = 30_000;

export type Latch = {
  /** What the caller should act on. */
  value: boolean;
  /** Set when the source says true; clears any pending fall. */
  raise: () => Latch;
  /** Asks to fall. Takes effect only once the grace has passed. */
  lower: (now: number) => Latch;
  /** Re-evaluated on a tick, so a fall that was asked for can land. */
  settle: (now: number) => Latch;
};

type State = { value: boolean; loweredAt: number | null };

function make(state: State, grace: number): Latch {
  return {
    value: state.value,
    raise: () => make({ value: true, loweredAt: null }, grace),
    lower: (now) =>
      state.loweredAt === null && state.value
        ? make({ value: true, loweredAt: now }, grace)
        : make(state, grace),
    settle: (now) =>
      state.loweredAt !== null && now - state.loweredAt >= grace
        ? make({ value: false, loweredAt: null }, grace)
        : make(state, grace),
  };
}

export function latch(initial = false, grace = FALL_GRACE_MS): Latch {
  return make({ value: initial, loweredAt: null }, grace);
}
