import { departureClock, formatDuration } from '@/features/airfare/lib/series';
import type { FareSnapshot } from '@/shared/api/fares';
import { formatMoney } from '@/shared/lib/money';

import styles from './FlightTable.module.css';

type FlightTableProps = {
  snapshot: FareSnapshot | null;
};

/** `0` reads as a number where "Direct" reads as a fact about the flight. */
function stopsLabel(transfers: number): string {
  if (transfers <= 0) return 'Direct';
  return `${transfers} stop${transfers === 1 ? '' : 's'}`;
}

/**
 * Every itinerary in the most recent observation, by airline and departure time.
 *
 * The chart answers "is it cheaper than usual"; this answers "cheaper on what".
 * A route whose median fell because one carrier added a red-eye is a different
 * story from one where every carrier dropped, and only this table tells them
 * apart.
 */
export function FlightTable({ snapshot }: FlightTableProps) {
  if (!snapshot || snapshot.offers.length === 0) {
    return <p className={styles.empty}>No itineraries in the latest observation.</p>;
  }

  return (
    <table className={styles.table}>
      <caption className={styles.caption}>
        Itineraries observed on {snapshot.capturedAt.slice(0, 10)} for departure{' '}
        {snapshot.flightDate}
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
        </tr>
      </thead>
      <tbody>
        {snapshot.offers.map((offer, index) => (
          <tr key={`${offer.airline}-${offer.flightNumber ?? index}-${offer.departureAt}`}>
            {/*
              Rendered as text, never through `Date`. `departureAt` is wall
              clock at the airport with no zone, so parsing it here would shift
              a 00:15 departure by the reader's own offset from Lima.
            */}
            <td>{departureClock(offer.departureAt)}</td>
            <td>{offer.airlineName ?? offer.airline}</td>
            <td>{offer.flightNumber ? `${offer.airline} ${offer.flightNumber}` : offer.airline}</td>
            <td>{stopsLabel(offer.transfers)}</td>
            <td>{formatDuration(offer.durationMinutes)}</td>
            <td className={styles.numeric}>{formatMoney(offer.price, offer.currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
