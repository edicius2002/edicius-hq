import { useEffect, useRef, useState, type MouseEvent } from 'react';

import {
  formatFlightMonth,
  formatFlightMonths,
  hasDeparted,
  monthHasDeparted,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { listEdge, type ListEdge } from '@/features/airfare/lib/listEdge';
import { shortMonth } from '@/features/airfare/lib/monthChips';
import type { PassProgress } from '@/features/airfare/lib/passProgress';
import type { RowReport } from '@/features/airfare/lib/rowReport';
import { ANALYSIS_PANEL_ID } from '@/features/airfare/ui/AnalysisPanel';
import { RouteEditor } from '@/features/airfare/ui/RouteEditor';
import { useReorder } from '@/shared/lib/useReorder';
import { Button } from '@/shared/ui/Button';

import styles from './RouteList.module.css';

type RouteListProps = {
  routes: FareRoute[];
  /** The colour this route's arc is drawn in, by route id. */
  colours: Map<string, string>;
  selectedId: string | null;
  today: string;
  /** Route ids whose own collection is in flight. Never more than a few. */
  collecting: readonly string[];
  /** What the last press on a row came back with, by route id. */
  reports: ReadonlyMap<string, RowReport>;
  /** How far each running pass has got, by route id. Absent means no bar. */
  progress: ReadonlyMap<string, PassProgress>;
  /** Which month of the selected route the chart is reading. */
  activeMonth: string | null;
  /** The watch loaded into the editor above, or null while it is adding. */
  editing: FareRoute | null;
  onSelect: (id: string) => void;
  /**
   * Open one month of one route: select the row, and read that month.
   *
   * One callback rather than two, because a press on a tab means both and a
   * page that had to be told twice could end up selected on one route while
   * reading a month of another.
   */
  onOpenMonth: (id: string, month: string) => void;
  onRemove: (id: string) => void;
  /**
   * Collect this one route now.
   *
   * Takes the route rather than its id, unlike `onRemove`: removing is an edit
   * to the stored document and the id is the whole of it, while a collection
   * needs both ends, the month and the currency. The row is holding all of
   * that already, so passing the id would only make the page look it up again.
   */
  onCollect: (route: FareRoute) => void;
  onAdd: (route: FareRoute) => void;
  onSave: (id: string, route: FareRoute) => void;
  /**
   * Put the fields back to adding a route.
   *
   * What a press on the empty part of this panel means. It clears the editor
   * and deliberately **not** the selection: the reader said they were done
   * editing, not that they were done looking at a chart.
   */
  onClearEditing: () => void;
  onMove: (from: string, to: string) => void;
};

/**
 * The collect control's mark: a circular arrow, drawn rather than typed.
 *
 * The row's other arrows are text — `→`, `↑`, `↓` — and a `↻` would have
 * matched them for a character of width. It is not typed because this app
 * ships no font file: `fonts.css` reaches for a locally installed Berkeley
 * Mono and otherwise falls through to whatever monospace the machine has, and
 * a glyph one of those fallbacks lacks renders as a box. The row's existing
 * arrows are in the part of the arrows block every monospace font covers; a
 * rotation arrow is not, and a tofu box beside Remove is worse than an inline
 * path that cannot fail.
 *
 * It spins only while its own request is in flight, in CSS, so an idle
 * watchlist animates nothing.
 */
function CollectMark({ busy }: { busy: boolean }) {
  return (
    <svg
      className={busy ? `${styles.mark} ${styles.spinning}` : styles.mark}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {/* Just under a full turn, so the gap and the head read as a rotation
          rather than as a ring. */}
      <path d="M13.17 9.88A5.5 5.5 0 1 1 11.89 4.11" />
      {/* The head, on the arc's end and pointing the way it travels. */}
      <path d="M8.78 3.54 11.89 4.11 11.32 1" />
    </svg>
  );
}

/**
 * The watchlist, with the fields that add to it standing above it.
 *
 * One panel rather than two, and the fields stay on screen rather than folding
 * away: adding a route is the thing this panel is *for*, and a control that
 * has to be opened before it can be used is one more step in front of the only
 * action here. They are laid out to cost less height than two list entries —
 * origin and destination on one row because they are one decision, the month
 * below because it is the next.
 *
 * **Only the rows scroll** — 12.269, following what 276530a settled for
 * Investing. A watchlist longer than the map beside it used to grow the panel,
 * which grew the grid row they share, which left the map with empty space
 * under it and the page with a scrollbar it had not asked for. The fields stay
 * put, which is the same argument the Investing rail makes: a list long enough
 * to scroll is exactly when you least want the way to add to it scrolled away.
 */
export function RouteList({
  routes,
  colours,
  selectedId,
  today,
  activeMonth,
  editing,
  collecting,
  reports,
  progress,
  onSelect,
  onOpenMonth,
  onRemove,
  onCollect,
  onAdd,
  onSave,
  onClearEditing,
  onMove,
}: RouteListProps) {
  /*
   * A press on the panel's own background puts the fields back to adding.
   *
   * Without it, choosing a row is a one-way door: the form is holding that
   * watch and the only way back to a blank one is the Cancel button beside the
   * heading, which is a long way from where the reader just pressed. Clicking
   * the empty space below the rows is what everyone tries first.
   *
   * `target === currentTarget` is the whole guard, and it has to be exact
   * rather than a `closest('li')` test: every press inside a row bubbles
   * through here, so anything looser would clear the editor on the way to
   * selecting a route. What passes it is a press that landed on the container
   * itself — the gaps between rows, the space under the last one, the panel's
   * own padding — and nothing else.
   */
  const clearOnBackdrop = (event: MouseEvent) => {
    if (event.target === event.currentTarget) onClearEditing();
  };
  // Order is not decoration here: the collector spends its daily request
  // budget down the list, so dragging a route to the top says "poll this one
  // first when there is not enough budget for everything".
  const { dragging, rowProps } = useReorder({
    order: routes.map(routeId),
    onMove,
  });

  /*
   * Whether there are rows above or below the ones on screen — 12.259.
   *
   * Read rather than assumed, because a mark drawn unconditionally is the page
   * claiming rows it does not have the moment the reader reaches the bottom.
   * The rule is `listEdge`, which is three numbers and a word and has its own
   * suite; all this does is ask it and put the answer where the stylesheet can
   * see it.
   *
   * Re-measured on scroll and whenever the list's own box changes. The
   * `ResizeObserver` is on the scroller rather than on the rows: the panel
   * shares a height with the map beside it, so the box moves when the window
   * does, and a mark left over from a taller box would outlive the overflow it
   * was drawn for. Content growth comes through the effect's dependencies
   * instead — a scroll container's border box does not change when a row is
   * added to it, so nothing would observe that.
   */
  const scroller = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState<ListEdge>('none');
  useEffect(() => {
    const node = scroller.current;
    if (!node) {
      setEdge('none');
      return;
    }
    const measure = () => setEdge(listEdge(node));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [routes, reports]);

  return (
    <div className={styles.panel} onClick={clearOnBackdrop}>
      {/*
        Keyed on the watch being edited, so choosing another row **remounts**
        the form and the fields reload from it. That is `PositionForm`'s
        behaviour by construction — the parent renders a different form per row
        — and deliberately not an effect syncing props into state, which is the
        stale-read this codebase has avoided everywhere else. The cost is a
        discarded draft when the reader clicks a row mid-typing; the draft is
        two codes and a chip set, and the alternative needs a dialog this app
        does not have.
      */}
      <RouteEditor
        key={editing ? routeId(editing) : 'new'}
        today={today}
        editing={editing}
        watched={routes.map(routeId)}
        onAdd={onAdd}
        onSave={onSave}
      />

      {routes.length === 0 ? (
        <p className={styles.empty} onClick={clearOnBackdrop}>
          No routes watched yet.
        </p>
      ) : (
        /*
          The box the marks are drawn on, which cannot be the scroller itself:
          a pseudo-element of a scroll container scrolls with its content, and
          a mark pinned to the bottom edge has to stay at the bottom edge.
        */
        <div className={styles.listBox} data-edge={edge} onClick={clearOnBackdrop}>
          <ul
            className={styles.list}
            ref={scroller}
            onClick={clearOnBackdrop}
            onScroll={(event) => setEdge(listEdge(event.currentTarget))}
            /*
              Reachable by keyboard, and this is the reason for both
              attributes. The rows hold buttons, so Tab does walk into the list
              and the browser scrolls to follow — but that is the only way in,
              and a reader who is reading rather than operating has none. A
              tab stop on the scroller itself gives them the arrow keys, at the
              cost of one stop before the first row, which is the trade every
              scrollable region makes. The name is what that stop announces;
              without it a screen reader reaches an unnamed box.
            */
            tabIndex={0}
            aria-label="Watched routes"
          >
            {routes.map((route) => {
              const id = routeId(route);
              // A month is over only once the calendar has left it. Half a month
              // can be in the past and the rest still worth collecting, which is
              // a distinction the collector draws day by day and this row cannot.
              // The comparison itself is `hasDeparted`, which used to be a
              // filter over the whole document for the page-wide collect button
              // and is a predicate now that a row is its only reader.
              const departed = hasDeparted(route, today);
              const busy = collecting.includes(id);
              const report = reports.get(id) ?? null;
              const bar = progress.get(id) ?? null;
              // Every month, explicitly. The row used to draw three and count
              // the rest, which meant the shape of a watch was legible and its
              // contents were not — the reader could see that a route had more
              // months than fitted and had to open the editor to learn which.
              // Four to a line is what the width allows; the lines are what a
              // watch with nine months costs, and it costs them only on that row.
              const drawn = route.months;
              // Where Tab lands in this row's tabs: the month being read where
              // this is the open row, and the first one otherwise. One stop per
              // row, so the group walks with the arrows rather than the tab key.
              const tabStop =
                id === selectedId && activeMonth !== null && drawn.includes(activeMonth)
                  ? activeMonth
                  : drawn[0];
              const monthsLabel = formatFlightMonths(route.months);
              return (
                <li
                  key={id}
                  className={`${styles.item} ${dragging === id ? styles.dragging : ''}`}
                  {...rowProps(id)}
                >
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={
                        id === selectedId ? `${styles.route} ${styles.selected}` : styles.route
                      }
                      aria-current={id === selectedId ? 'true' : undefined}
                      onClick={() => onSelect(id)}
                    >
                      {/*
                      The colour this route is drawn in on the map. Eight arcs
                      leave Lima together, and without this the reader has no
                      way to tell which line is the row they are looking at.
                    */}
                      <span
                        className={styles.swatch}
                        style={{ background: colours.get(id) ?? 'var(--color-muted)' }}
                        aria-hidden="true"
                      />
                      {/*
                      Split so the arrow can be smaller and quieter than the
                      two codes — it is punctuation, not information. Read
                      aloud it becomes the word, because "LIM right-arrow CUZ"
                      is not how anyone says a route.
                    */}
                      <span className={styles.pair}>
                        {route.origin}{' '}
                        <span className={styles.to} aria-hidden="true">
                          →
                        </span>
                        <span className={styles.sr}>to</span> {route.destination}
                      </span>
                    </button>
                    {/*
                      The months, as tabs.

                      They are siblings of the row button rather than children
                      of it, because a `<button>` may not contain buttons — so
                      the whole-row press shrinks to the swatch and the pair.
                      What compensates is that pressing any tab also selects the
                      row: `onOpenMonth` does both, so a press anywhere on the
                      row still opens it and a press on a tab additionally says
                      which month.

                      **Not `role="tab"`.** That role obliges a `tablist` whose
                      tabs own `tabpanel`s, and there would be one tablist per
                      row — ten of them, nine inert, each still claiming a
                      selected tab — pointing at a panel that already has its own
                      chart switch inside it. `aria-current` is the honest,
                      weaker thing and is this row's existing idiom; `aria-
                      controls` names what the press actually moves.

                      One tab stop per row rather than one per tab: forty extra
                      stops between the reader and Remove is not a bargain.
                      Arrow keys walk and open, and they cannot collide with the
                      drag — `useReorder` claims `Alt+Arrow` and returns
                      immediately without it, while this returns immediately
                      *with* it.
                    */}
                    <span
                      className={styles.months}
                      role="group"
                      aria-label={`Months watched for ${routeLabel(route)}`}
                      // Where the year lives, since a three-letter tab cannot
                      // carry one — see `shortMonth`.
                      title={monthsLabel}
                      onKeyDown={(event) => {
                        if (event.altKey) return;
                        const step =
                          event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                        if (step === 0) return;
                        event.preventDefault();
                        const from = route.months.indexOf(tabStop);
                        const next = route.months[from + step];
                        if (next === undefined) return;
                        onOpenMonth(id, next);
                      }}
                    >
                      {drawn.map((month) => {
                        const open = id === selectedId && month === activeMonth;
                        return (
                          <button
                            key={month}
                            type="button"
                            className={[
                              styles.monthTab,
                              open ? styles.monthTabOpen : '',
                              monthHasDeparted(month, today) ? styles.monthTabGone : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            aria-label={
                              monthHasDeparted(month, today)
                                ? `${formatFlightMonth(month)} — departed`
                                : formatFlightMonth(month)
                            }
                            aria-current={open ? 'true' : undefined}
                            aria-controls={ANALYSIS_PANEL_ID}
                            tabIndex={month === tabStop ? 0 : -1}
                            onClick={() => onOpenMonth(id, month)}
                          >
                            {shortMonth(month)}
                          </button>
                        );
                      })}
                    </span>
                    {/*
                      Every month has been and gone. Its history stays — that is
                      the point of an archive — but nothing more will be
                      collected, and saying so is cheaper than letting the reader
                      wonder why the series stopped. A watch with one stale month
                      beside two live ones is not this, and keeps its press.
                    */}
                    {departed ? <span className={styles.departed}>Departed</span> : null}
                    {/*
                    Collect this one route, now, without waiting for a pass
                    over the whole list. Absent rather than disabled on a
                    departed route: the provider answers nothing about a flight
                    that has left, so there is no press to invite — the row
                    already says "Departed", and a greyed control beside it
                    would only make the reader wonder what would happen.
                  */}
                    {departed ? null : (
                      <Button
                        variant="ghost"
                        size="small"
                        className={styles.collect}
                        onClick={() => onCollect(route)}
                        disabled={busy}
                        aria-busy={busy || undefined}
                        // One press, every month the watch can still collect,
                        // one pass — so the name says how many rather than
                        // naming the one the reader happens to be reading.
                        aria-label={
                          busy
                            ? `Collecting ${routeLabel(route)}, ${monthsLabel}`
                            : `Collect ${routeLabel(route)} now, ${monthsLabel}`
                        }
                      >
                        <CollectMark busy={busy} />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => onRemove(id)}
                      // The pair and every month of it. The month name is gone
                      // from here on purpose: with tabs in the row, "Stop
                      // watching LIM → CUZ in March 2027" would read as an offer
                      // to drop one month. Dropping one is the editor's job.
                      aria-label={`Stop watching ${routeLabel(route)}`}
                    >
                      Remove
                    </Button>
                  </div>
                  {/*
                  Always rendered, empty until there is something to say. An
                  empty paragraph with no margin lays out no line box and so
                  costs no height — and a live region has to be in the document
                  before its content changes if a screen reader is to announce
                  it, which a node that appears along with its own text is not.
                */}
                  {/*
                    How far the pass has got, drawn — and drawn only.

                    `aria-hidden`, with no `progressbar` role and no figures of
                    its own, because the line underneath is already saying
                    "Collecting: 4 of 31 departures so far" into a live region
                    every two seconds. A bar that also carried the numbers would
                    print them twice on one row, and one that carried them
                    instead would make the words a duplicate of a picture a
                    screen reader cannot see. This is the picture of a figure
                    already reported; it adds nothing to the accessibility tree
                    and takes nothing out of it.

                    Absent rather than emptied when there is nothing to draw:
                    `passProgress` returns nothing for a pass that has stopped,
                    for one that belongs to another row, and for one whose plan
                    settled at no departures at all — so a row that is between
                    presses costs no element and the list is exactly the height
                    it was.
                  */}
                  {bar ? (
                    <div
                      className={
                        bar.fraction === null
                          ? `${styles.progress} ${styles.unplanned}`
                          : styles.progress
                      }
                      aria-hidden="true"
                      data-testid={`collect-progress-${id}`}
                    >
                      <span
                        className={styles.fill}
                        style={
                          bar.fraction === null
                            ? undefined
                            : { width: `${Math.min(1, bar.fraction) * 100}%` }
                        }
                      />
                    </div>
                  ) : null}
                  <p
                    className={
                      report && !report.ok ? `${styles.report} ${styles.refused}` : styles.report
                    }
                    aria-live="polite"
                  >
                    {report?.text ?? ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
