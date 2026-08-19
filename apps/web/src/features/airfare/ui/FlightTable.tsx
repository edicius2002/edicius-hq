import { trackFlights, variation, type FlightTrack } from '@/features/airfare/lib/flights';
import { departureClock, formatDuration, formatStamp } from '@/features/airfare/lib/series';
import type { FareSnapshot } from '@/shared/api/fares';
import { formatMoney, NO_VALUE } from '@/shared/lib/money';

import styles from './FlightTable.module.css';

type FlightTableProps = {
  snapshots: FareSnapshot[];
};

/** `0` reads as a number where "Direct" reads as a fact about the flight. */
function stopsLabel(transfers: number): string {
  if (transfers <= 0) return 'Direct';
  return `${transfers} stop${transfers === 1 ? '' : 's'}`;
}

/**
 * How a flight's price has moved since it was last something else.
 *
 * An em dash rather than `0%` when a flight has only ever been seen at one
 * price: "has not moved" and "has only been observed once" are different
 * facts, and printing 0% would claim a steadiness nobody watched.
 */
function moveLabel(track: FlightTrack): string {
  const percent = variation(track.previousPrice, track.price);
  if (percent === null) return '—';
  const rounded = percent.toFixed(1);
  return `${percent > 0 ? '+' : ''}${rounded}%`;
}

function moveClass(track: FlightTrack): string | undefined {
  const percent = variation(track.previousPrice, track.price);
  if (percent === null || percent === 0) return undefined;
  return percent > 0 ? styles.up : styles.down;
}

/**
 * Every flight the archive has seen for this route, and what each one has done.
 *
 * The chart answers "is the route cheaper than usual"; this answers "cheaper on
 * what, and which ones moved". A route whose cheapest fare fell because one
 * carrier added a red-eye is a completely different story from one where every
 * carrier dropped, and only a per-flight view tells them apart.
 *
 * Flights that have left the board stay in the table, marked. A departure that
 * stopped being sold is one of the more useful things this archive can tell
 * you, and dropping it would make the route look like it never had one.
 */
export function FlightTable({ snapshots }: FlightTableProps) {
  const tracks = trackFlights(snapshots);
  if (tracks.length === 0) {
    return <p className={styles.empty}>No itineraries observed yet.</p>;
  }

  const latest = [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1);
  const showing = tracks.filter((track) => track.present).length;

  return (
    <table className={styles.table}>
      <caption className={styles.caption}>
        {showing} of {tracks.length} itineraries on the board, last observed{' '}
        {latest ? formatStamp(latest.capturedAt) : NO_VALUE} for departure{' '}
        {latest ? formatStamp(latest.flightDate) : NO_VALUE}
      </caption>
      <thead>
        <tr>
          <th scope="col">Departs</th>
          <th scope="col">Airline</th>
          <th scope="col">Flight</th>
          <th scope="col">Stops</th>
          <th scope="col">Duration</th>
          <th scope="col" className={styles.numeric}>
            Price
          </th>
          <th scope="col" className={styles.numeric}>
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((track) => (
          <tr key={track.key} className={track.present ? undefined : styles.gone}>
            {/*
              Rendered as text, never through `Date`. `departureAt` is wall
              clock at the airport with no zone, so parsing it here would shift
              a 00:15 departure by the reader's own offset from Lima.
            */}
            <td>{departureClock(track.departureAt)}</td>
            <td>{track.airlineName ?? track.airline}</td>
            <td>{track.flightNumber ? `${track.airline} ${track.flightNumber}` : track.airline}</td>
            <td>{stopsLabel(track.transfers)}</td>
            <td>{formatDuration(track.durationMinutes)}</td>
            <td className={styles.numeric}>{formatMoney(track.price, track.currency)}</td>
            <td className={`${styles.numeric} ${moveClass(track) ?? ''}`.trim()}>
              {track.present ? moveLabel(track) : 'off the board'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
