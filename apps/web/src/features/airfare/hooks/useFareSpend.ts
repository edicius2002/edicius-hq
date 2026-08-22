import { useQuery } from '@tanstack/react-query';

import { fetchFareSpend, type FareSpend } from '@/shared/api/fares';

/**
 * How often the day's spend is asked for again.
 *
 * A minute, and it is chosen against two numbers. The scheduler this exists for
 * runs a pass every **fifteen** minutes, so a minute is four readings inside the
 * quietest gap and a reader watching sees a pass land within one of them. And
 * the call is ~200 bytes off a local file of one short line per request sent
 * today, with no upstream anywhere in it — which is what makes a timer defensible here and
 * not on `/history`, where the same habit would have cost 21 MB a pass.
 */
const SPEND_POLL_MS = 60_000;

/**
 * What this address has already sent today — `spend-is-read-back-not-only-written`.
 *
 * **Polled, and deliberately not carried on the pass stream.** There is a
 * server-sent stream for a collection pass (`a-pass-is-pushed-not-polled`) and
 * it is the wrong carrier for this, for a reason that is about *which* passes
 * matter. That stream exists only while a pass runs, and in this app it is
 * opened by a row that pressed and closed the moment its pass ends — so
 * everything it could report about spending belongs to a pass somebody was
 * already sitting in front of. The passes this figure is for are the other
 * ninety-six: unattended, every fifteen minutes, with the page shut. A number
 * that only moved while a stream happened to be open would be freshest exactly
 * when it mattered least, and would show a reader who has just opened the tab
 * nothing at all until they pressed something.
 *
 * So: a fetch on mount, a refetch every minute, and a refetch when the tab is
 * focused again. The focus one is not decoration — this page is the sort of
 * thing left open in a background tab for a day, and React Query pauses the
 * timer while the window is in the background, so coming back to a stale figure
 * is the exact case that would otherwise be silently wrong.
 *
 * `staleTime: 0` against the app-wide 30 seconds, so remounting the page reads
 * the file rather than the cache. The whole value of this readout is that it is
 * current when somebody looks at it.
 *
 * A pass the reader starts here invalidates `['fares', 'spend']` when it ends —
 * see `useRouteCollection` and `useHorizonCollection` — so their own spending
 * appears at once rather than up to a minute later.
 */
export function useFareSpend() {
  return useQuery<FareSpend>({
    queryKey: ['fares', 'spend'],
    queryFn: ({ signal }) => fetchFareSpend({ signal }),
    refetchInterval: SPEND_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}
