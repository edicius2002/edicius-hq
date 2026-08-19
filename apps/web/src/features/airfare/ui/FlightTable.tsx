import { useMemo, useState } from 'react';

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
import { departureClock, formatDuration } from '@/features/airfare/lib/series';
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
 * An em dash rather than `0%` when a flight has only ever been seen at one
 * price: "has not moved" and "has only been observed once" are different
 * facts, and printing 0% would claim a steadiness nobody watched.
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

function FlightRowCells({ row }: { row: FlightRow }) {
  const { track } = row;
  return (
    <>
      {/*
        Rendered as text, never through `Date`. `departureAt` is wall clock at
        the airport with no zone, so parsing it here would shift a 00:15
        departure by the reader's own offset from Lima.
      */}
      <td>{departureClock(track.departureAt)}</td>
      <td>{track.airlineName ?? track.airline}</td>
      <td>{track.flightNumber ? `${track.airline} ${track.flightNumber}` : track.airline}</td>
      <td>{stopsLabel(track.transfers)}</td>
      <td>{formatDuration(track.durationMinutes)}</td>
      <td className={styles.numeric}>{formatMoney(track.price, track.currency)}</td>
      <td className={`${styles.numeric} ${moveClass(row.change) ?? ''}`.trim()}>
        {track.present ? moveLabel(row.change) : CHANGE_LABELS.gone.toLowerCase()}
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
export function FlightTable({ snapshots, granularity }: FlightTableProps) {
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
    return <p className={styles.empty}>No itineraries observed yet.</p>;
  }

  const currency = rows[0]?.track.currency ?? 'USD';
  const summary = tableSummary({
    period,
    inPeriod: rows.length,
    shown: visible.length,
    tracked,
    page: slice.page,
    pageCount: slice.pageCount,
  });

  return (
    <div className={styles.wrap}>
      <div className={styles.filters} role="group" aria-label="Filter flights">
        <label className={styles.filter}>
          <span>Min price</span>
          <input
            type="number"
            inputMode="decimal"
            value={filters.minPrice ?? ''}
            placeholder={facets.price ? String(Math.floor(facets.price.low)) : ''}
            onChange={(event) => update({ minPrice: optionalNumber(event.target.value) })}
          />
        </label>
        <label className={styles.filter}>
          <span>Max price</span>
          <input
            type="number"
            inputMode="decimal"
            value={filters.maxPrice ?? ''}
            placeholder={facets.price ? String(Math.ceil(facets.price.high)) : ''}
            onChange={(event) => update({ maxPrice: optionalNumber(event.target.value) })}
          />
        </label>
        <label className={styles.filter}>
          <span>Airline</span>
          <select
            value={filters.airline ?? ''}
            onChange={(event) => update({ airline: optional(event.target.value) })}
          >
            <option value="">All airlines</option>
            {facets.airlines.map((airline) => (
              <option key={airline.value} value={airline.value}>
                {airline.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span>Departs</span>
          <select
            value={filters.band ?? ''}
            onChange={(event) => update({ band: optional(event.target.value) as TimeBand | null })}
          >
            <option value="">Any time</option>
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
            <option value="">Any stops</option>
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
            <option value="">Any length</option>
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
            <option value="">Any move</option>
            {facets.categories.map((category) => (
              <option key={category} value={category}>
                {CHANGE_LABELS[category]}
              </option>
            ))}
          </select>
        </label>
        {isFiltered(filters) ? (
          <Button size="small" className={styles.clear} onClick={() => update(NO_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {facets.price ? (
        <p className={styles.range}>
          The board runs {formatMoney(facets.price.low, currency)} to{' '}
          {formatMoney(facets.price.high, currency)} across {facets.airlines.length} airline
          {facets.airlines.length === 1 ? '' : 's'}.
        </p>
      ) : null}

      <table className={styles.table}>
        {/*
          Announced when it changes, because filtering is exactly the moment a
          reader needs to hear how many rows went away — and the count is the
          only thing on screen that says so.
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
              <FlightRowCells row={row} />
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
