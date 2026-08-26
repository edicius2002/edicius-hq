import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { openCollectionStream } from '@/features/airfare/data/collectionStream';
import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  NOTICE_LIFE_MS,
  collectNotice,
  withNotice,
  withoutNotice,
  type CollectNotice,
} from '@/features/airfare/lib/collectNotice';
import { withSnapshot } from '@/features/airfare/lib/liveSnapshot';
import { passProgress, type PassProgress } from '@/features/airfare/lib/passProgress';
import {
  describeCollection,
  describeProgress,
  describeRefusal,
  type RowReport,
} from '@/features/airfare/lib/rowReport';
import {
  collectFares,
  fetchCollectionProgress,
  type CollectResponse,
  type FareHistoryResponse,
  type FareSnapshot,
} from '@/shared/api/fares';

/**
 * How often a running pass is asked how it is getting on, **when the stream is
 * not available**.
 *
 * Two seconds against a pass whose own requests are three apart, so the row
 * never sits on a figure that is more than one departure stale. The call reads
 * state the API already holds in memory and reaches no upstream, which is what
 * makes polling cheap enough to keep as the fallback rather than delete.
 */
const PROGRESS_POLL_MS = 2_000;

/**
 * How long a broken stream is given to come back before the row stops waiting
 * for it.
 *
 * An `EventSource` reconnects by itself — most of why it was chosen over a
 * socket — and its default retry is about three seconds, so a blip costs one
 * attempt and this window covers two. What it protects against is the other
 * case: a stream that cannot be established at all, or one whose server has
 * gone for good. Without a deadline that row waits for a frame that is never
 * coming and shows a bar that never moves, which is the failure 8.8 and 8.41
 * name — a failure that is not reported is worse than one that is.
 */
const STREAM_GRACE_MS = 8_000;

/**
 * Collecting one watched route on its own, from the row it sits on.
 *
 * **A press collects the month it is on, now, whatever the cadence says** —
 * `a-press-collects-the-month-it-is-on`, settling 12.212 and superseding
 * 12.111's hold over this one control. 12.111 put the schedule in front of the
 * press for a reason that was about *cost*: under 12.110 a row is a month, so a
 * press buys up to thirty-one requests rather than the one 12.90 was arguing
 * about. What the reproduction showed is that the cost is bounded — one row is
 * one route-month and never the watchlist — while the cure was worse than the
 * disease: a press at 21:04 after a pass at 14:41 came back `31 not-due`, and a
 * button that argues with the person pressing it reads as broken.
 *
 * So the press sends `force` and the schedule is left in charge of everything
 * else: the scheduled pass, the command line and any other caller of
 * `POST /api/fares/collect` still run the cadence. What the press does **not**
 * get past is the request budget or the pass lock, and both come back as
 * ordinary skipped reasons — `over-budget`, `another-pass-is-running` — that
 * `describeCollection` renders with the word the server used.
 *
 * **A press starts a pass and then watches it** — 12.210. The call used to
 * hold the connection open for the whole collection, and the browser's own
 * five-minute deadline was therefore what decided how much of a watchlist one
 * press could cover. Now the press returns as soon as the pass has started and
 * the row follows it, so nothing bounds a pass except the request budget.
 *
 * **And it follows it by listening rather than by asking** —
 * `a-pass-is-pushed-not-polled`. This used to sleep two seconds in a loop and
 * re-ask `GET /api/fares/collect`. That poll was cheap and is still here as the
 * fallback; what it could never buy was the thing the reader actually
 * complained about. A pass is minutes long, the charts read
 * `GET /api/fares/history`, and that endpoint answers with every snapshot for
 * the city pair — 91 snapshots at ~327 kB plus 1,846 baseline points at ~123 kB
 * on this archive, growing without bound. So the archive was refreshed only
 * when the pass *ended*, the charts sat still for four minutes, and the reader
 * reloaded the page to make something happen. `GET /collect/stream` pushes each
 * departure as it lands, snapshot and all, and the chart gains its point with
 * nobody asking for anything.
 *
 * **One stream, however many rows are watching.** The server keeps one pass
 * slot, so every watching row is watching the same pass and a second
 * `EventSource` would carry the same frames twice. The rows live in a ref keyed
 * by `routeId` and each frame is applied to all of them — which is also what
 * keeps `watching` honest: each row asks `isOurPass` of the same document and
 * answers for itself.
 *
 * **One mutation, many rows.** A hook cannot be called in a loop, so per-row
 * state lives here as two collections keyed by `routeId`: which presses are in
 * flight, and what the last one on each row came back with. React Query's own
 * `isPending` is deliberately not used for the disabling — it is one flag for
 * the whole mutation, and reading it per row is exactly how one row's press
 * ends up greying out every other row's button.
 *
 * The in-flight guard is a ref as well as state because only the ref is
 * synchronous. `disabled` on the button stops the second press of a human
 * double-click, which is tens of milliseconds and several renders later; two
 * presses dispatched inside one tick would both see the old state and both
 * fire, and the ref is what closes that.
 *
 * **Three guards stop an impatient reader spending the day, and only the third
 * is load-bearing.** A forced press is a minute and a half of paced requests
 * behind a control that answers instantly, which is exactly the hazard 12.212
 * named. The ref above refuses a repeat while the row's own press is in flight,
 * and it holds for the whole pass rather than for the call, because `release`
 * runs when the pass *ends*. The button is disabled over the same window, so
 * there is usually nothing to click. Neither of those is what makes it safe:
 * `CollectionRunner` keeps one pass slot, so a press that got past both is
 * answered with the pass already running and starts nothing, and `PassLock`
 * says the same thing across processes. A browser guard can be defeated by a
 * second tab; the server's slot cannot.
 */
export type RouteCollection = {
  /** Route ids whose own press is in flight. */
  collecting: readonly string[];
  /** What the last press on a row came back with, by route id. */
  reports: ReadonlyMap<string, RowReport>;
  /**
   * How far each running pass has got, by route id.
   *
   * Separate from `reports` and not a field inside one, because the two have
   * different lifetimes on purpose: a report is the last thing a row was told
   * and outlives the press, while this exists only while a pass is running and
   * is dropped the moment it stops. A row with an entry here has a bar; a row
   * without one has words. Merging them would mean every reader of a finished
   * report carrying a fraction that no longer means anything.
   */
  progress: ReadonlyMap<string, PassProgress>;
  /**
   * The finished presses that have not faded yet, oldest first.
   *
   * A third lifetime beside the other two, and the shortest of them: a report
   * outlives its press and waits to be superseded, a bar exists only while the
   * pass runs, and this exists for ten seconds after the pass ends and then
   * goes on its own. It is the same sentence as the row's report — deliberately
   * so, `collectNotice` argues it out — carried where a reader who has scrolled
   * away, opened a chart or gone to another window will actually see it.
   *
   * Only a pass this browser pressed for ever appears here. The scheduled
   * collector runs every fifteen minutes and must not interrupt anybody.
   */
  notices: readonly CollectNotice[];
  /**
   * Collect one month of one route, now.
   *
   * The month is passed in rather than derived, because the row knows which one
   * it is reading and this hook does not — see `a-press-collects-the-month-on-screen`.
   */
  collect: (route: FareRoute, month: string) => void;
  /** Drop a row's report and its card, for when the row itself goes. */
  forget: (id: string) => void;
};

/*
 * It took a `today` and no longer does — the same shape of removal
 * `useFareRoutes` records. The date was here for one thing: filtering departed
 * months out of the payload while a press collected every month of its watch.
 * A press now collects the one month the row is reading and sends it whether or
 * not it has departed (see the payload for why), so the clock this hook asked
 * for had nothing left to decide.
 */
export function useRouteCollection(): RouteCollection {
  const queryClient = useQueryClient();
  const [collecting, setCollecting] = useState<readonly string[]>([]);
  const [reports, setReports] = useState<ReadonlyMap<string, RowReport>>(() => new Map());
  const [progress, setProgress] = useState<ReadonlyMap<string, PassProgress>>(() => new Map());
  const [notices, setNotices] = useState<readonly CollectNotice[]>([]);
  const inFlight = useRef<Set<string>>(new Set());
  /**
   * The clock each card is on, by route id.
   *
   * A ref because nothing draws it and because the callback that clears it has
   * to be able to find the handle from outside the render that made it. Keyed
   * by row so a second press on one row can cancel its own card's timer without
   * touching another row's — which is what makes "a row replaces its own card"
   * restart the clock rather than inherit the remains of the first one's.
   */
  const noticeTimers = useRef<Map<string, number>>(new Map());
  /**
   * The rows following the pass, by route id.
   *
   * A ref rather than state: it is read by stream callbacks that outlive the
   * render which registered them, and rendering is not what it is for. What the
   * reader sees is `reports` and `progress`, which are state and are written
   * from here.
   */
  const following = useRef<Map<string, FareRoute>>(new Map());
  const closeStream = useRef<(() => void) | null>(null);
  const graceTimer = useRef<number | null>(null);
  // The stream and the poll both outlive the render that started them, so both
  // have to be able to find out that the page has gone. Without this, a pass
  // left running while the reader navigates away sets state on an unmounted
  // tree until it finishes.
  const mounted = useRef(true);

  const write = useCallback((id: string, report: RowReport | null) => {
    setReports((current) => {
      const next = new Map(current);
      if (report) next.set(id, report);
      else next.delete(id);
      return next;
    });
  }, []);

  /** Take a row's card out of the corner now, and stop the clock it was on. */
  const dismiss = useCallback((id: string) => {
    const timer = noticeTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      noticeTimers.current.delete(id);
    }
    setNotices((current) => withoutNotice(current, id));
  }, []);

  /**
   * A finished press put in front of the reader, and given ten seconds.
   *
   * `collectNotice` decides whether there is anything to raise at all — a
   * running pass and somebody else's pass both come back null — so this only
   * has the timer to keep. The old timer goes first: a second press on the same
   * row replaces its card, and a card that kept the first press's clock would
   * vanish moments after the second one landed.
   *
   * The card is not the record. Whatever it says, the row's own line says too
   * and goes on saying until the next press supersedes it, which is what makes
   * a card safe to take away on a timer nobody asked for.
   */
  const announce = useCallback((route: FareRoute, response: CollectResponse) => {
    const notice = collectNotice(route, response);
    if (!notice) return;
    const running = noticeTimers.current.get(notice.id);
    if (running !== undefined) window.clearTimeout(running);
    setNotices((current) => withNotice(current, notice));
    noticeTimers.current.set(
      notice.id,
      window.setTimeout(() => {
        noticeTimers.current.delete(notice.id);
        if (!mounted.current) return;
        setNotices((current) => withoutNotice(current, notice.id));
      }, NOTICE_LIFE_MS),
    );
  }, []);

  /**
   * Where the bar is, or that there is no bar.
   *
   * `passProgress` answers null for every pass a row should not draw — finished,
   * somebody else's, or planned at nothing — so this deletes on null rather than
   * asking the same three questions a second time here. One rule, one place, and
   * a row can never be left with a bar the rule would not have drawn.
   */
  const mark = useCallback((id: string, at: PassProgress | null) => {
    setProgress((current) => {
      if (at === null && !current.has(id)) return current;
      const next = new Map(current);
      if (at) next.set(id, at);
      else next.delete(id);
      return next;
    });
  }, []);

  const release = useCallback(
    (id: string) => {
      inFlight.current.delete(id);
      setCollecting((current) => current.filter((other) => other !== id));
      // The bar goes with the press it belonged to, whichever way the press
      // ended. A pass that failed leaves its reason in words; a bar frozen at
      // four of thirty-one beside that reason would read as still working.
      mark(id, null);
    },
    [mark],
  );

  /**
   * What the archive is asked for again once a pass has stopped.
   *
   * Still here, and still at the end, even though the snapshots now arrive as
   * they are written. The stream carries the points; it deliberately carries
   * neither the baseline nor the health counts nor the airports, none of which
   * is a point on a chart and all of which a finished pass may have moved. This
   * is how those catch up, which is exactly how current they were before.
   */
  const refreshArchive = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['fares', 'history'] });
    void queryClient.invalidateQueries({ queryKey: ['fares', 'airports'] });
    /*
     * And the day's spend, which this pass has just moved —
     * `spend-is-read-back-not-only-written`. It refetches on its own every minute
     * anyway; what this buys is that a press the reader made themselves is on
     * the header strip when the row's line appears rather than up to a minute
     * afterwards. A press is the one piece of spending they can attribute, and
     * a figure that lagged it would teach them the strip is slow.
     */
    void queryClient.invalidateQueries({ queryKey: ['fares', 'spend'] });
  }, [queryClient]);

  const stopStream = useCallback(() => {
    closeStream.current?.();
    closeStream.current = null;
    if (graceTimer.current !== null) {
      window.clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // The map itself, taken here rather than read again in the cleanup. The
    // ref holds one `Map` for the life of the hook and is never reassigned —
    // only its entries move — so the two readings are the same object, and
    // taking it now is what tells the linter that as well as the reader.
    const timers = noticeTimers.current;
    return () => {
      mounted.current = false;
      stopStream();
      // The cards' clocks go the way the stream does, and for the same reason:
      // a callback that fires into a tree which is no longer there is at best
      // wasted work, and one left per press accumulates for as long as the tab
      // is open. Cleared here rather than trusted to the `mounted` guard inside
      // them, because a guard that returns early is still a timer that ran.
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [stopStream]);

  /**
   * One pass document, read by every row that is following it.
   *
   * Each row asks `isOurPass` of the same document and answers for itself,
   * which is what keeps the one thing that must not regress: a press arriving
   * while a pass is running is answered with *that* pass (12.210), and a row
   * reporting a stranger's pass as its own would be the quietest lie this
   * control can tell.
   */
  const applyPass = useCallback(
    (response: CollectResponse) => {
      if (!mounted.current) return;
      let ended = false;
      for (const [id, route] of [...following.current]) {
        if (response.state === 'running') {
          write(id, describeProgress(route, response));
          mark(id, passProgress(route, response));
          continue;
        }
        following.current.delete(id);
        write(id, describeCollection(route, response));
        announce(route, response);
        release(id);
        ended = true;
      }
      if (ended) refreshArchive();
      if (following.current.size === 0) stopStream();
    },
    [announce, mark, refreshArchive, release, stopStream, write],
  );

  /**
   * A snapshot laid straight into the archive the charts are drawn from.
   *
   * Every cached month for that city pair, because that is what the endpoint
   * itself answers: `/history` narrows the baseline and the health counts to a
   * departure prefix and returns `snapshots` for the whole pair. A merge into
   * only the month that pressed would leave the other month's cache holding
   * less than a refetch would give it, and the two would disagree.
   */
  const applySnapshot = useCallback(
    (snapshot: FareSnapshot) => {
      if (!mounted.current) return;
      queryClient.setQueriesData<FareHistoryResponse>(
        { queryKey: ['fares', 'history', snapshot.origin, snapshot.destination] },
        (held) => (held ? withSnapshot(held, snapshot) : held),
      );
    },
    [queryClient],
  );

  /**
   * Ask instead of listen, for as long as this row's pass runs.
   *
   * The fallback, and unchanged in what it reports: the same document, the same
   * three readings of it. What a row loses by arriving here is only liveness —
   * the chart stops gaining points as they land and catches up when the pass
   * ends, which is what it did before any of this existed. That is why the poll
   * was kept rather than deleted: on a network where server-sent events do not
   * survive the trip, this change must not be able to make the row worse than
   * it was.
   */
  const pollUntilDone = useCallback(
    async (route: FareRoute) => {
      const id = routeId(route);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
        if (!mounted.current || !inFlight.current.has(id)) return;
        let latest: CollectResponse;
        try {
          latest = await fetchCollectionProgress();
        } catch (error) {
          write(id, describeRefusal(error instanceof Error ? error.message : String(error)));
          release(id);
          return;
        }
        if (!mounted.current) return;
        if (latest.state === 'running') {
          write(id, describeProgress(route, latest));
          mark(id, passProgress(route, latest));
          continue;
        }
        write(id, describeCollection(route, latest));
        announce(route, latest);
        release(id);
        refreshArchive();
        return;
      }
    },
    [announce, mark, refreshArchive, release, write],
  );

  /**
   * The stream has gone quiet for longer than a reconnect takes.
   *
   * Said in words first and then acted on. The words are superseded by the next
   * progress line two seconds later, which is a fair trade rather than an
   * oversight: what the reader needs to know is that the chart has stopped
   * filling in, and what the row needs to do is keep reporting the pass. A row
   * that simply waited for a frame that is not coming would be a spinner with
   * no end, which is the one outcome that is worse than saying so.
   */
  const fallBackToPolling = useCallback(() => {
    const stranded = [...following.current.values()];
    following.current.clear();
    stopStream();
    for (const route of stranded) {
      write(routeId(route), {
        ok: false,
        text: 'The live feed dropped; checking every two seconds instead. The charts will catch up when the pass ends.',
      });
      void pollUntilDone(route);
    }
  }, [pollUntilDone, stopStream, write]);

  const armGrace = useCallback(() => {
    if (graceTimer.current !== null) return;
    graceTimer.current = window.setTimeout(() => {
      graceTimer.current = null;
      if (following.current.size > 0) fallBackToPolling();
    }, STREAM_GRACE_MS);
  }, [fallBackToPolling]);

  const disarmGrace = useCallback(() => {
    if (graceTimer.current === null) return;
    window.clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  /**
   * Follow a pass the press has already started.
   *
   * The stream is opened once and shared: the server keeps one slot, so every
   * following row is following the same pass and a second `EventSource` would
   * carry identical frames.
   */
  const follow = useCallback(
    (route: FareRoute) => {
      following.current.set(routeId(route), route);
      if (closeStream.current) return;
      closeStream.current = openCollectionStream({
        onOpen: disarmGrace,
        onPass: (response) => {
          disarmGrace();
          applyPass(response);
        },
        onSnapshot: applySnapshot,
        onError: armGrace,
      });
    },
    [applyPass, applySnapshot, armGrace, disarmGrace],
  );

  // Only `mutate` is taken off the result: the object React Query returns is
  // new on every render, so closing over it would rebuild `collect` every
  // render and defeat the `useCallback` around it. `mutate` itself is stable.
  const { mutate } = useMutation<CollectResponse, Error, { route: FareRoute; month: string }>({
    mutationFn: ({ route, month }) =>
      collectFares(
        /*
         * One entry, for the one month the row is reading —
         * `a-press-collects-the-month-on-screen`.
         *
         * It sent every month of the watch, in one pass, and that is reversed.
         * A press is a control on a row and the row is showing one month at a
         * time; collecting the other two was the button doing more than the
         * reader could see it do, and on a twelve-month watch it was ~372
         * requests and nineteen minutes behind a control that answers instantly.
         *
         * The month is passed in rather than derived here. The row knows which
         * one it is reading — the open tab where it is the open row, the month
         * it would open on otherwise — and this hook does not; deriving it from
         * the document would put the answer in the one place that cannot see
         * the tab.
         *
         * A departed month is **sent** rather than filtered out, which reverses
         * the other half of the old payload's reasoning. That filter existed
         * because a wholly departed month bought thirty-one skip lines that
         * pushed the reasons that mattered out of the row's commonest-first
         * summary — and with one month there are no other reasons to crowd out.
         * `Not collected: 31 departed.` is the true and useful answer, and it
         * needs no code that does not already exist.
         */
        [
          {
            origin: route.origin,
            destination: route.destination,
            month,
            currency: route.currency,
          },
        ],
        // And it buys the whole month rather than the handful of days whose turn
        // has come — `a-press-collects-the-month-it-is-on`. A press at 21:04
        // after a pass at 14:41 answered `31 not-due`, which is 12.111 working
        // as designed and is nevertheless the wrong answer to give somebody who
        // has just said they do not believe the last look. The pass lock is
        // untouched by it, so a scheduled pass still comes back
        // `another-pass-is-running`, which this row already renders.
        //
        // The endpoint still bounds a forced press at one city pair rather than
        // one entry. Nothing here sends more than one now, and the wider bound
        // stays because it is the honest one — it is where `collect_calendars`
        // has always drawn the line, and narrowing it back would be the API
        // describing one client's habit.
        { force: true },
      ),
    // The press only starts the pass — 12.210 — so this is where the following
    // begins rather than where the outcome is written. A pass that came back
    // already finished (nothing was due, or somebody else's pass was handed
    // over) is done here and never opens a stream at all.
    onSuccess: (data, { route }) => {
      const id = routeId(route);
      if (data.state !== 'running') {
        write(id, describeCollection(route, data));
        announce(route, data);
        release(id);
        refreshArchive();
        return;
      }
      write(id, describeProgress(route, data));
      mark(id, passProgress(route, data));
      follow(route);
    },
    onError: (error, { route }) => {
      const id = routeId(route);
      write(id, describeRefusal(error.message));
      release(id);
    },
  });

  const collect = useCallback(
    (route: FareRoute, month: string) => {
      const id = routeId(route);
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setCollecting((current) => [...current, id]);
      // The previous outcome goes with the press that supersedes it. Leaving
      // last week's "Refused" beside a spinner would have the row saying two
      // things at once, and the older one louder.
      write(id, null);
      mutate({ route, month });
    },
    [mutate, write],
  );

  /*
   * The card goes with the report it repeats. A route id is content rather
   * than a handle — the same pair in the same month rebuilds the same id — so
   * a card left floating would land over a route that had just been added
   * back, saying something about a press nobody there had made.
   */
  const forget = useCallback(
    (id: string) => {
      write(id, null);
      dismiss(id);
    },
    [dismiss, write],
  );

  return { collecting, reports, progress, notices, collect, forget };
}
