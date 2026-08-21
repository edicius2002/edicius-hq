import { useId, useMemo, useState } from 'react';

import {
  airlineSearchUrl,
  flightLinkLabel,
  type FlightSearch,
} from '@/features/airfare/lib/airlineSearch';
import type { Granularity } from '@/features/airfare/lib/buckets';
import {
  CHANGE_LABELS,
  DEFAULT_SORT,
  NO_FILTERS,
  TIME_BANDS,
  durationLabel,
  facetsOf,
  filterRows,
  isFiltered,
  nextSort,
  pageOf,
  shortAirline,
  sortRows,
  stopsLabel,
  tableRows,
  tableSummary,
  type ChangeCategory,
  type FlightRow,
  type Filters,
  type Sort,
  type SortColumn,
  type TimeBand,
} from '@/features/airfare/lib/flightTable';
import { formatDuration, formatStamp } from '@/features/airfare/lib/series';
import type { FareSnapshot } from '@/shared/api/fares';
import { Button } from '@/shared/ui/Button';
import { formatMoney } from '@/shared/lib/money';

import styles from './FlightTable.module.css';

type FlightTableProps = {
  snapshots: FareSnapshot[];
  /**
   * The period the chart above is drawn in. Required rather than defaulted:
   * a table that quietly showed the whole archive while the chart showed one
   * day would be two answers to one question.
   */
  granularity: Granularity;
  /**
   * The departure this route is watched on, already written the way this page
   * writes dates — `09/03/2027` for a focused day, `March 2027` for a month.
   *
   * Formatted by the caller rather than derived here, because the route and
   * the rules for reading it live in `data/fareRoutes` and this component is
   * handed snapshots, not a route. Null when nothing is selected.
   */
  departure: string | null;
  /**
   * Where these flights leave from and go to, and which country the origin is
   * in — the three things a link out to an airline's own search needs and a
   * row does not carry.
   *
   * A row knows its carrier, its flight number and its departure stamp. It does
   * not know the city pair, because a `FlightTrack` is one itinerary followed
   * through the archive rather than a route; and the country is not in the
   * archive at all, it comes off the airports table the page already holds.
   * Null while either is unknown, which draws no links rather than links into
   * the wrong storefront.
   */
  leg: { origin: string; destination: string; originCountry: string | null } | null;
};

const COLUMNS: { column: SortColumn; label: string; numeric?: boolean }[] = [
  { column: 'departs', label: 'Departs' },
  { column: 'airline', label: 'Airline' },
  { column: 'flight', label: 'Flight' },
  { column: 'stops', label: 'Stops' },
  { column: 'duration', label: 'Duration' },
  { column: 'price', label: 'Price', numeric: true },
  { column: 'change', label: 'Change', numeric: true },
];

/**
 * How a flight's price has moved since it was last something else.
 *
 * An em dash rather than `0%` when nothing has been compared: "has not moved"
 * and "has only been observed once" are different facts, and printing 0% would
 * claim a steadiness nobody watched. The row that *has* been watched twice and
 * held its price gets the `0.0%`, because that one is a measurement — 12.254.
 */
function moveLabel(change: number | null): string {
  if (change === null) return '—';
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function moveClass(change: number | null): string | undefined {
  if (change === null || change === 0) return undefined;
  return change > 0 ? styles.up : styles.down;
}

/** An empty option value is "no filter"; a select cannot hold `null`. */
function optional(value: string): string | null {
  return value === '' ? null : value;
}

function optionalNumber(value: string): number | null {
  const parsed = Number(value);
  return value === '' || !Number.isFinite(parsed) ? null : parsed;
}

/**
 * A column heading that sorts.
 *
 * A real `<button>` rather than a click handler on the `<th>`, so the header
 * is in the tab order and answers the space bar; `aria-sort` on the cell
 * rather than in the button's text, so a screen reader announces the order as
 * a property of the column instead of as part of its name. The arrow is
 * `aria-hidden` for the same reason — it repeats what `aria-sort` already
 * says.
 */
function SortHeader({
  column,
  label,
  numeric,
  sort,
  onSort,
}: {
  column: SortColumn;
  label: string;
  numeric?: boolean;
  sort: Sort;
  onSort: (column: SortColumn) => void;
}) {
  const active = sort.column === column;
  const ariaSort = !active ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending';
  return (
    <th scope="col" aria-sort={ariaSort} className={numeric ? styles.numeric : undefined}>
      <button
        type="button"
        className={`${styles.sort} ${active ? styles.sorted : ''}`.trim()}
        onClick={() => onSort(column)}
      >
        {label}
        <span aria-hidden="true" className={styles.arrow}>
          {active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

/**
 * The panel's heading, which since 12.257 is the first thing on the filter
 * row rather than a line of its own above it.
 *
 * `Flights seen · 09/03/2027`, with the middot the watchlist row already uses
 * between a pair and its month, rather than the `Flights seen departing on
 * 09/03/2027` this replaced. Eleven characters of the row bought back.
 *
 * The date is the *departure* — which day's board these flights were on. The
 * caption under the table carries a different date, the day the collector
 * looked, and the two now sit a table apart saying different things. That is
 * known and deliberately not reconciled here: which of them a heading should
 * carry is a decision about the product, not about this row, and quietly
 * swapping one for the other while moving it would settle it by accident.
 *
 * Rendered even when the table has nothing to show, because a panel whose
 * heading disappears with its data reads as a panel that lost its name.
 */
function TableHeading({ departure }: { departure: string | null }) {
  return (
    <h2 className={styles.title}>
      Flights seen
      {departure === null ? null : (
        <>
          <span aria-hidden="true" className={styles.dot}>
            ·
          </span>
          {departure}
        </>
      )}
    </h2>
  );
}

/**
 * The flight number, which is the way out to the airline's own booking search
 * wherever there is one — and plain text wherever there is not.
 *
 * **The number is the anchor now, and the muted `↗` beside it is gone.** That
 * mark was `color: var(--color-muted); font-size: 0.7rem; text-decoration:
 * none` — a 14px grey arrow with no underline, which worked and which the owner
 * could not find: _"quita esa flecha apagada de la tabla y en vez de eso
 * colocalo en AR 1281 ... como hipervinculo"_. The fix for an invisible
 * affordance is a visible one, so the link takes the one word in the row a
 * reader is already looking at and is drawn the way the web draws links, in
 * `--color-link` and underlined.
 *
 * **The table keeps a link, and that is a decision rather than an oversight.**
 * The owner pointed at the chart's readout, which is where the link now
 * primarily lives; but the readout names exactly one flight — whichever the
 * crosshair is on — so a table with no link would mean finding a dot in a cloud
 * of ~899 before a row could reach its carrier, and would leave a keyboard
 * reader walking an SVG to do it. Both places draw the same link in the same
 * blue, so the two panels do not disagree about what a linkable flight looks
 * like.
 *
 * **What that costs is that the visible text now overpromises.** `AR 1281` in
 * link blue reads as a link to AR 1281, and the destination is a route-and-date
 * search the reader matches by the clock — a bigger claim than the arrow made,
 * taken deliberately, and answered where the answer is load-bearing:
 * `flightLinkLabel` writes the accessible name and the tooltip, and it says
 * `AR 1281 — Search Aerolíneas Argentinas for AEP to MDZ on 02/03/2027`.
 *
 * **The scatter above still carries no anchors.** Its ~899 marks are bare
 * `<circle>` elements inside a chart that pans on a drag and tells a click from
 * a drag by how far the pointer travelled; an anchor on each of them would have
 * the browser's own link activation racing that disambiguation on every press.
 * What the marks carry instead is a blue centre saying that this flight has a
 * link, and the link itself is in the readout under the plot.
 *
 * A new tab, because the reader is mid-comparison: this table is one of four
 * panels about a route they are reading, and navigating the page away from it
 * throws the sort, the filters and the page number they set. `noreferrer` with
 * it as the standard guard on a cross-origin `_blank`.
 */
function FlightName({ track, leg }: { track: FlightRow['track']; leg: FlightTableProps['leg'] }) {
  const name = track.flightNumber ? `${track.airline} ${track.flightNumber}` : track.airline;
  if (leg === null) return <>{name}</>;

  const search: FlightSearch = {
    airline: track.airline,
    origin: leg.origin,
    destination: leg.destination,
    /*
      The departure date off the wall clock by string, never through `Date` —
      the same rule the departure cell keeps. A 00:15 departure from Lima read
      in the reader's own offset would search the day before.
    */
    date: track.departureAt.slice(0, 10),
    originCountry: leg.originCountry,
  };
  const url = airlineSearchUrl(search);
  // Avianca, and any origin whose country has no storefront we have loaded:
  // plain text, no marker and no greyed affordance. A link nobody has opened is
  // a guess, and 2% of rows quietly reaching a 404 costs more than 2% reaching
  // nothing.
  if (url === null) return <>{name}</>;

  const label = flightLinkLabel(name, search, track.airlineName);
  return (
    <a
      className={styles.flightLink}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
    >
      {name}
    </a>
  );
}

function FlightRowCells({ row, leg }: { row: FlightRow; leg: FlightTableProps['leg'] }) {
  const { track } = row;
  return (
    <>
      {/*
        Rendered as text, never through `Date`. `departureAt` is wall clock at
        the airport with no zone, so parsing it here would shift a 00:15
        departure by the reader's own offset from Lima.
      */}
      {/*
        The day as well as the clock — 12.110. The table used to cover one
        departure, so every row left on the same date and printing it thirty
        times would have been noise; a watched month puts thirty-one days of
        flights in here at once, and `08:15` on its own no longer says which
        flight it is. `formatStamp` writes it `09/03/2027 08:15`, the same
        `dd/mm/yyyy` this page writes every other real date in, and by string
        split rather than through `Date` — `departureAt` is wall clock at the
        airport and has no zone to convert from.
      */}
      <td>{formatStamp(track.departureAt)}</td>
      <td>{track.airlineName ?? track.airline}</td>
      <td>
        <FlightName track={track} leg={leg} />
      </td>
      <td>{stopsLabel(track.transfers)}</td>
      <td>{formatDuration(track.durationMinutes)}</td>
      <td className={styles.numeric}>{formatMoney(track.price, track.currency)}</td>
      {/*
        A flight that has left the board says so in this column rather than
        showing a dash, because "it is not offered any more" is an answer to
        "what has this fare done" and a dash is the answer for a fare nobody
        has compared yet — 12.256. The word is set as a word: the column is
        tabular numerals for the percentages, and lining a lower-case `Gone`
        up on a decimal point would be a figure that is not a figure.
      */}
      <td
        className={`${styles.numeric} ${row.category === 'gone' ? styles.word : ''} ${moveClass(row.change) ?? ''}`.trim()}
      >
        {row.category === 'gone' ? CHANGE_LABELS.gone : moveLabel(row.change)}
      </td>
    </>
  );
}

/**
 * The flights the route was showing over the chart's most recent period, and
 * what each one has done.
 *
 * The chart answers "is the route cheaper than usual"; this answers "cheaper
 * on what, and which ones moved". A route whose cheapest fare fell because one
 * carrier added a red-eye is a completely different story from one where every
 * carrier dropped, and only a per-flight view tells them apart.
 *
 * Sorting, filtering and the page number are held here and nowhere else. They
 * are deliberately not persisted — a filter still in force a week later, on a
 * route the reader has since changed, is a table lying quietly — and they
 * deliberately do not reach the chart, which is the route's own series: if
 * filtering the table moved the line, "cheapest" would mean something
 * different depending on which airline was selected.
 */
export function FlightTable({ snapshots, granularity, departure, leg }: FlightTableProps) {
  const priceLabelId = useId();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [shownPeriod, setShownPeriod] = useState<Granularity>(granularity);

  /*
   * A new period is a different set of flights, so page four of the old one is
   * not a page of this one. Adjusted while rendering rather than in an effect:
   * an effect would paint the stale page first and correct it a frame later,
   * which is the flicker React's own guidance on this pattern exists to avoid.
   */
  if (shownPeriod !== granularity) {
    setShownPeriod(granularity);
    setPage(1);
  }

  const { rows, period, tracked } = useMemo(
    () => tableRows(snapshots, granularity),
    [snapshots, granularity],
  );
  const facets = useMemo(() => facetsOf(rows), [rows]);
  const visible = useMemo(() => sortRows(filterRows(rows, filters), sort), [rows, filters, sort]);
  const slice = pageOf(visible, page);

  // Every filter change resets the page, and none of them resets the sort: the
  // reader chose that order and a narrower table is still in it.
  function update(change: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...change }));
    setPage(1);
  }

  if (tracked === 0) {
    return (
      <div className={styles.wrap}>
        <TableHeading departure={departure} />
        <p className={styles.empty}>No itineraries observed yet.</p>
      </div>
    );
  }

  const summary = tableSummary({
    period,
    inPeriod: rows.length,
    shown: visible.length,
    tracked,
  });

  return (
    <div className={styles.wrap}>
      {/*
        Heading, departure and every filter on one line — 12.257, where there
        is room for one line. At the panel's real 1099px a one-carrier board
        has it and a four-carrier one is 16px short: see `.head` in the
        stylesheet for the four measurements and for why forcing the rest would
        make this panel taller rather than shorter.

        The heading is a sibling of the filter group rather than a member of
        it: a group labelled "Filter flights" that contained the panel's `<h2>`
        would be telling a screen reader that the heading is one of the
        controls.
      */}
      <div className={styles.head}>
        <TableHeading departure={departure} />
        <div className={styles.filters} role="group" aria-label="Filter flights">
          {/*
          One control, not two — 12.252. A floor and a ceiling are the two ends
          of one question, and asking it as two separately-labelled boxes spent
          two of the row's six slots on it and read as two unrelated filters.
          A `div` with `role="group"` rather than a `label` around both fields,
          because a label may name one control and these are two; each field
          carries its own `aria-label`, so "Min price" still names the box a
          screen reader lands in and the group above it still says "Price".

          The two placeholders are what the board actually runs between, which
          is why the sentence that used to say so in prose is gone: the range
          now sits inside the control the reader would use to narrow it.
        */}
          <div className={styles.filter}>
            <span id={priceLabelId}>Price</span>
            <div className={styles.range} role="group" aria-labelledby={priceLabelId}>
              <input
                type="number"
                inputMode="decimal"
                aria-label="Min price"
                value={filters.minPrice ?? ''}
                placeholder={facets.price ? String(Math.floor(facets.price.low)) : ''}
                onChange={(event) => update({ minPrice: optionalNumber(event.target.value) })}
              />
              <span aria-hidden="true" className={styles.dash}>
                –
              </span>
              <input
                type="number"
                inputMode="decimal"
                aria-label="Max price"
                value={filters.maxPrice ?? ''}
                placeholder={facets.price ? String(Math.ceil(facets.price.high)) : ''}
                onChange={(event) => update({ maxPrice: optionalNumber(event.target.value) })}
              />
            </div>
          </div>
          {/*
          `Any` rather than `All airlines`, `Any time`, `Any stops`, `Any
          length`, `Any move` — one word, five selects, 12.252. A select is as
          wide as its widest option, so five differently-worded ways of saying
          "no constraint" were setting three of the six controls' widths
          between them, and every one of them repeated a label sitting directly
          above it: `Departs / Any time` says "time" twice and `Stops / Any
          stops` says "stops" twice.
        */}
          <label className={styles.filter}>
            <span>Airline</span>
            <select
              value={filters.airline ?? ''}
              title={facets.airlines.find((one) => one.value === filters.airline)?.label}
              onChange={(event) => update({ airline: optional(event.target.value) })}
            >
              <option value="">Any</option>
              {/*
                Cut to eight characters — 12.258. `title` carries the name
                whole, so a truncated option answers a hover in the open list
                and the closed control answers one too; the Airline column of
                every row below is the other place it is written in full.
              */}
              {facets.airlines.map((airline) => (
                <option key={airline.value} value={airline.value} title={airline.label}>
                  {shortAirline(airline.label)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filter}>
            <span>Departs</span>
            <select
              value={filters.band ?? ''}
              onChange={(event) =>
                update({ band: optional(event.target.value) as TimeBand | null })
              }
            >
              <option value="">Any</option>
              {TIME_BANDS.filter((band) => facets.bands.includes(band.value)).map((band) => (
                <option key={band.value} value={band.value}>
                  {band.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filter}>
            <span>Stops</span>
            <select
              value={filters.stops === null ? '' : String(filters.stops)}
              onChange={(event) => update({ stops: optionalNumber(event.target.value) })}
            >
              <option value="">Any</option>
              {facets.stops.map((stops) => (
                <option key={stops} value={stops}>
                  {stopsLabel(stops)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filter}>
            <span>Duration</span>
            <select
              value={filters.maxDuration === null ? '' : String(filters.maxDuration)}
              onChange={(event) => update({ maxDuration: optionalNumber(event.target.value) })}
            >
              <option value="">Any</option>
              {facets.durations.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {durationLabel(minutes)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filter}>
            <span>Change</span>
            <select
              value={filters.change ?? ''}
              onChange={(event) =>
                update({ change: optional(event.target.value) as ChangeCategory | null })
              }
            >
              <option value="">Any</option>
              {facets.categories.map((category) => (
                <option key={category} value={category}>
                  {CHANGE_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
          {/*
          `Clear` on the button, "Clear filters" to anything that reads names:
          the row is six controls wide and the seven characters this saves are
          the difference between one row and two at panel width. The visible
          word is the first word of the accessible name, which is what WCAG
          2.5.3 asks of a shortened label.
        */}
          {isFiltered(filters) ? (
            <Button
              size="small"
              className={styles.clear}
              aria-label="Clear filters"
              onClick={() => update(NO_FILTERS)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      <table className={styles.table}>
        {/*
          Under the rows rather than over them — 12.253. It is still the
          table's `<caption>`, so it is still the thing a screen reader reads
          when it enters the table, and it is still announced when it changes,
          because filtering is exactly the moment a reader needs to hear how
          many rows went away. What moved is where it sits: two lines of prose
          between the filters and the first flight pushed the board itself off
          the bottom of the panel, and the reader who came for the board was
          reading around them.
        */}
        <caption className={styles.caption} aria-live="polite">
          {summary}
        </caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <SortHeader
                key={column.column}
                column={column.column}
                label={column.label}
                numeric={column.numeric}
                sort={sort}
                onSort={(next) => setSort((current) => nextSort(current, next))}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {slice.rows.map((row) => (
            <tr key={row.track.key} className={row.track.present ? undefined : styles.gone}>
              <FlightRowCells row={row} leg={leg} />
            </tr>
          ))}
        </tbody>
      </table>

      {slice.rows.length === 0 ? (
        <p className={styles.empty}>
          {rows.length === 0
            ? 'No flights were on the board in this period.'
            : 'Every flight in this period is hidden by the filters above.'}
        </p>
      ) : null}

      {slice.pageCount > 1 ? (
        <nav className={styles.pager} aria-label="Flight table pages">
          <Button size="small" disabled={slice.page <= 1} onClick={() => setPage(slice.page - 1)}>
            Previous page
          </Button>
          <span className={styles.pageOf}>{`Page ${slice.page} of ${slice.pageCount}`}</span>
          <Button
            size="small"
            disabled={slice.page >= slice.pageCount}
            onClick={() => setPage(slice.page + 1)}
          >
            Next page
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
