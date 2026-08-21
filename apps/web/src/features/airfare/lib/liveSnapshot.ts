import type { FareHistoryResponse, FareSnapshot } from '@/shared/api/fares';

/**
 * A snapshot that arrived on the stream, laid into the archive already fetched.
 *
 * Pure, and its own module rather than a closure inside the hook, for
 * `lib/series` and `lib/buckets`' reason: what happens at the awkward moments —
 * the same snapshot arriving twice, one arriving for a route this query is not
 * about, one arriving out of order after a reconnect — is worth pinning in a
 * test rather than inferring from a hook.
 *
 * **Why the snapshot travels rather than a nudge to refetch.** The alternative
 * was to push only the *fact* that a snapshot landed and have the client fetch
 * it, which `GET /api/fares/history` can already narrow — it accepts `since`
 * and `until` and the client has never sent either. It was rejected on what the
 * narrowing does not cover: `since` filters the snapshots and nothing else, so
 * every incremental fetch would still carry the whole baseline — 1,846 points
 * at ~123 kB on this archive — behind the two or three kilobytes actually
 * wanted. Roughly nineteen such fetches over a four-minute pass is 2.3 MB to
 * deliver perhaps 70 kB of news. Pushing the snapshot costs one message of
 * about 3.6 kB and no request at all.
 *
 * The usual objection to pushing data is drift: a wire format becomes a second
 * way to construct a thing and the two grow apart. That is a real failure here
 * — `quoteStream`'s `extended` is the scar — but it is drift between a *thin
 * cousin* and the real type. The frame on this stream is `SnapshotModel`, the
 * same model an element of `snapshots` is rendered from, so there is one
 * construction path and one vocabulary. Nothing below reinterprets a field.
 *
 * **What is deliberately not merged.** `baseline` and `health` come back
 * untouched. The baseline changes only on the first look at a departure, and
 * `health` is a running count of every poll whatever its outcome — neither is a
 * point on a chart and neither is worth a wire format of its own. Both catch up
 * from the refetch that already happens when the pass ends, which is exactly
 * how current they were before any of this existed.
 */
export function withSnapshot(
  history: FareHistoryResponse,
  snapshot: FareSnapshot,
): FareHistoryResponse {
  // A stream carries every pass on the machine, and a reader can be watching
  // one route while another route's pass is running — one slot, whoever pressed
  // first (12.210). A snapshot for a pair this query is not about is not this
  // query's news.
  if (snapshot.origin !== history.origin || snapshot.destination !== history.destination) {
    return history;
  }

  const at = index(history.snapshots, snapshot);
  // Already held. An `EventSource` replays from its last id after a reconnect,
  // and the frame that follows a reconnect is routinely one already applied —
  // so this is the ordinary case rather than a guard against a bug. Returning
  // the same object rather than an equal one is what stops it costing a render.
  if (at !== null) return history;

  return { ...history, snapshots: insert(history.snapshots, snapshot) };
}

/**
 * Where this snapshot already sits, or null.
 *
 * Keyed on the observation and the departure together. `capturedAt` alone is
 * not a key — a pass polls a month at three-second intervals, but two
 * departures whose looks fall inside the same second are ordinary and the
 * archive keeps both.
 */
function index(snapshots: FareSnapshot[], candidate: FareSnapshot): number | null {
  const found = snapshots.findIndex(
    (held) => held.capturedAt === candidate.capturedAt && held.flightDate === candidate.flightDate,
  );
  return found === -1 ? null : found;
}

/**
 * Placed by observation date, oldest first — the order `/history` answers in.
 *
 * A pass collects in order, so the common case is a snapshot newer than
 * everything held and the append below is the whole of it. The search exists
 * for the case that is not: a reconnect can deliver a frame after a later one,
 * and a series drawn from an out-of-order array is a line that doubles back on
 * itself.
 */
function insert(snapshots: FareSnapshot[], snapshot: FareSnapshot): FareSnapshot[] {
  const last = snapshots[snapshots.length - 1];
  if (!last || last.capturedAt <= snapshot.capturedAt) return [...snapshots, snapshot];

  const at = snapshots.findIndex((held) => held.capturedAt > snapshot.capturedAt);
  return [...snapshots.slice(0, at), snapshot, ...snapshots.slice(at)];
}
