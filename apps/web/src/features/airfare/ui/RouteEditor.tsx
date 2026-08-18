import { useState, type FormEvent } from 'react';

import {
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  isAirportCode,
  isCalendarDate,
  normalizeCode,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import type { Airport } from '@/shared/api/fares';
import { Button } from '@/shared/ui/Button';

import styles from './RouteEditor.module.css';

type RouteEditorProps = {
  onAdd: (route: FareRoute) => void;
  /** Today, `YYYY-MM-DD`. Passed in rather than read, so tests do not drift. */
  today: string;
  /**
   * Airports the archive already knows, offered as you type.
   *
   * Only ones that have been collected — the coordinates and city names come
   * from the searches themselves, so this list starts small and grows with the
   * watchlist. It is a shortcut, never a gate: any three letters can still be
   * typed, and an unknown code is watched like any other.
   */
  airports?: Airport[];
};

/**
 * The fields that add a route, always on screen at the top of the watchlist.
 *
 * Origin and destination on one row because they are one decision; the dates
 * below them because they are the next one; the button last. Four inputs and a
 * control, sized so the whole thing costs less vertical room than two entries
 * of the list it sits above.
 *
 * It validates before it submits rather than letting the normalizer drop a bad
 * entry silently: a route that vanishes on save looks like a broken button,
 * and the reader has no way to learn that `2026-02-31` was the problem.
 */
export function RouteEditor({ onAdd, today, airports = [] }: RouteEditorProps) {
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
      {/*
        A native datalist rather than a custom menu: it filters as you type,
        works with the keyboard for free, and — the part that matters here —
        never blocks a code it has not heard of.
      */}
      <datalist id="airfare-known-airports">
        {airports.map((airport) => (
          <option key={airport.code} value={airport.code}>
            {airport.city ? `${airport.city} — ${airport.name ?? airport.code}` : airport.code}
          </option>
        ))}
      </datalist>

      <div className={styles.row}>
        <div className={styles.field}>
          <label htmlFor="airfare-origin">Origin</label>
          <input
            id="airfare-origin"
            list="airfare-known-airports"
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
            list="airfare-known-airports"
            value={destination}
            onChange={(event) => setDestination(event.target.value.toUpperCase())}
            maxLength={3}
            placeholder="SCL"
            autoComplete="off"
          />
        </div>
      </div>

      <div className={styles.row}>
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
      </div>

      <Button type="submit" variant="primary" size="small" className={styles.submit}>
        Add route
      </Button>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
