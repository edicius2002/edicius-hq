import { useState, type FormEvent } from 'react';

import {
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  isAirportCode,
  isCalendarDate,
  normalizeCode,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { Button } from '@/shared/ui/Button';

import styles from './RouteEditor.module.css';

type RouteEditorProps = {
  onAdd: (route: FareRoute) => void;
  /** Today, `YYYY-MM-DD`. Passed in rather than read, so tests do not drift. */
  today: string;
};

/**
 * The form that adds a route to the watchlist.
 *
 * It validates before it submits rather than letting the normalizer drop a bad
 * entry silently: a route that vanishes on save looks like a broken button,
 * and the reader has no way to learn that `2026-02-31` was the problem.
 */
export function RouteEditor({ onAdd, today }: RouteEditorProps) {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState('');
  const [flightDate, setFlightDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();

    if (!isAirportCode(origin) || !isAirportCode(destination)) {
      setError('Origin and destination must be three-letter IATA codes.');
      return;
    }
    if (normalizeCode(origin) === normalizeCode(destination)) {
      setError('Origin and destination are the same airport.');
      return;
    }
    if (!isCalendarDate(flightDate)) {
      setError('Departure date must be a real date.');
      return;
    }
    if (flightDate < today) {
      setError('That departure has already left.');
      return;
    }
    if (returnDate && (!isCalendarDate(returnDate) || returnDate < flightDate)) {
      setError('Return date must be a real date on or after the departure.');
      return;
    }

    onAdd({
      origin: normalizeCode(origin),
      destination: normalizeCode(destination),
      flightDate,
      returnDate: returnDate || null,
      currency: DEFAULT_CURRENCY,
    });

    setDestination('');
    setFlightDate('');
    setReturnDate('');
    setError(null);
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Add a route to watch">
      <div className={styles.field}>
        <label htmlFor="airfare-origin">Origin</label>
        <input
          id="airfare-origin"
          value={origin}
          onChange={(event) => setOrigin(event.target.value.toUpperCase())}
          maxLength={3}
          placeholder="LIM"
          autoComplete="off"
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="airfare-destination">Destination</label>
        <input
          id="airfare-destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value.toUpperCase())}
          maxLength={3}
          placeholder="SCL"
          autoComplete="off"
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="airfare-departure">Departure</label>
        <input
          id="airfare-departure"
          type="date"
          value={flightDate}
          min={today}
          onChange={(event) => setFlightDate(event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="airfare-return">Return (optional)</label>
        <input
          id="airfare-return"
          type="date"
          value={returnDate}
          min={flightDate || today}
          onChange={(event) => setReturnDate(event.target.value)}
        />
      </div>
      <Button type="submit" variant="primary">
        Watch route
      </Button>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
