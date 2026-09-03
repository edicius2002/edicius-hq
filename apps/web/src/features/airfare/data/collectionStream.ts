import { getApiBaseUrl } from '@/shared/api/config';
import type { CalendarCollectResponse, CollectResponse, FareSnapshot } from '@/shared/api/fares';
import { withStreamToken } from '@/shared/auth/streamUrl';

/**
 * A collection pass, pushed rather than asked for —
 * `a-pass-is-pushed-not-polled`.
 *
 * The same arrangement as `data/quoteStream` and for the same reasons — plan
 * decision 8.19: server-sent events rather than a socket, because this
 * direction is the only one carrying anything and an `EventSource` reconnects
 * by itself. Nothing here names a provider (8.3).
 *
 * **What it replaces.** A press starts a pass on the server and returns in
 * about seven milliseconds (12.210); the pass itself is minutes long, paced at
 * three seconds a departure over a month of up to thirty-one of them. The rows
 * used to ask `GET /api/fares/collect` every two seconds, which is cheap — it
 * reads memory and reaches no upstream — and the poll is still here as the
 * fallback. What no poll could pay for is the *chart*: it reads
 * `GET /api/fares/history`, which answers with every snapshot for the city pair
 * — measured at 91 snapshots, ~327 kB, plus 1,846 baseline points at ~123 kB,
 * and growing without bound. So the archive was only ever refreshed when the
 * pass ended, and a reader watching four minutes of a frozen chart reloads the
 * page. That is the complaint this exists to answer.
 *
 * **Two events, and neither invents a shape.** `pass` is the document
 * `GET /collect` answers with, and `snapshot` is an element of
 * `GET /history`'s `snapshots`. That is deliberate rather than convenient. The
 * quote stream did it the other way — `tick_payload` is a thinner cousin of the
 * REST quote — and the two drifted, with the socket emitting an `EXTENDED`
 * market state this codebase had no branch for, because one question was being
 * answered in two places. A frame that *is* the REST type cannot drift from it,
 * and that is what makes merging a pushed snapshot into a fetched query safe.
 */

/** What arrives on the board-collection stream. */
export type CollectionStreamOptions = {
  /**
   * The pass as it stands. Handed over whole rather than as a delta, so every
   * reader of it — the row's sentence, its bar, its "is this even my pass"
   * check — is the function it already was.
   */
  onPass: (response: CollectResponse) => void;
  /**
   * A snapshot the archive has just taken. Only for a look that actually
   * *wrote*: a poll that found the board unchanged writes nothing, and at a
   * half-hourly cadence that is most polls.
   */
  onSnapshot?: (snapshot: FareSnapshot) => void;
  onOpen?: () => void;
  onError?: () => void;
  /** Injected in tests; the browser's own class otherwise. */
  create?: (url: string) => EventSource;
};

export type HorizonStreamOptions = {
  onPass: (response: CalendarCollectResponse) => void;
  onOpen?: () => void;
  onError?: () => void;
  create?: (url: string) => EventSource;
};

export function collectionStreamUrl(): string {
  return `${getApiBaseUrl()}/api/fares/collect/stream`;
}

export function horizonStreamUrl(): string {
  return `${getApiBaseUrl()}/api/fares/calendar/collect/stream`;
}

/**
 * Reads one JSON frame, or ignores it.
 *
 * A frame we cannot parse is a reason to ignore that frame and nothing more.
 * The stream sits in front of a poll that still works and a refresh that still
 * happens when the pass ends, so it must never be able to break either — the
 * same rule `quoteStream` states about its own batches.
 */
function readFrame<T>(event: Event, apply: (value: T) => void): void {
  try {
    const value = JSON.parse((event as MessageEvent<string>).data) as T;
    if (value && typeof value === 'object') apply(value);
  } catch {
    // Deliberately silent. See above.
  }
}

/**
 * Opens the board-collection stream and returns the function that closes it.
 *
 * The first `pass` frame arrives before anything has been waited for, so a tab
 * that connects part-way through a pass is caught up rather than left waiting
 * for the next departure — and one that connects to an idle machine is told so
 * at once instead of sitting silent for twenty seconds.
 */
export function openCollectionStream(options: CollectionStreamOptions): () => void {
  const create = options.create ?? ((url: string) => new EventSource(url));
  const source = create(withStreamToken(collectionStreamUrl()));

  source.addEventListener('open', () => options.onOpen?.());
  source.addEventListener('pass', (event) => readFrame<CollectResponse>(event, options.onPass));
  source.addEventListener('snapshot', (event) =>
    readFrame<FareSnapshot>(event, (snapshot) => options.onSnapshot?.(snapshot)),
  );
  source.addEventListener('error', () => options.onError?.());

  return () => source.close();
}

/**
 * Opens the booking-horizon stream and returns the function that closes it.
 *
 * No `snapshot` event, and the omission is the server's judgement rather than
 * this file's: a curve is one city pair and two paced requests, so there is no
 * halfway point a reader could act on. "Has it stopped yet" is the whole of
 * what the two-second poll was asking, and one `pass` frame answers it.
 */
export function openHorizonStream(options: HorizonStreamOptions): () => void {
  const create = options.create ?? ((url: string) => new EventSource(url));
  const source = create(withStreamToken(horizonStreamUrl()));

  source.addEventListener('open', () => options.onOpen?.());
  source.addEventListener('pass', (event) =>
    readFrame<CalendarCollectResponse>(event, options.onPass),
  );
  source.addEventListener('error', () => options.onError?.());

  return () => source.close();
}
