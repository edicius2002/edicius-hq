import { useState, type FormEvent } from 'react';

import {
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  isAirportCode,
  isCalendarDate,
  normalizeCode,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { AirportField } from '@/features/airfare/ui/AirportField';

import styles from './RouteEditor.module.css';

/**
 * The form's id, so the button that submits it can live somewhere else.
 *
 * "Add route" sits in the panel's own header, up beside the heading, which is
 * outside this form. A submit button carries a `form` attribute for exactly
 * this: the association is stated rather than inherited from the tree.
 */
export const ADD_ROUTE_FORM_ID = 'airfare-add-route';

type RouteEditorProps = {
  onAdd: (route: FareRoute) => void;
  /** Today, `YYYY-MM-DD`. Passed in rather than read, so tests do not drift. */
  today: string;
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
    <form
      id={ADD_ROUTE_FORM_ID}
      className={styles.form}
      onSubmit={submit}
      aria-label="Add a route to watch"
    >
      <div className={styles.row}>
        <AirportField
          id="airfare-origin"
          label="Origin"
          value={origin}
          placeholder="LIM"
          onChange={setOrigin}
          align="left"
        />
        <AirportField
          id="airfare-destination"
          label="Destination"
          value={destination}
          placeholder="SCL"
          onChange={setDestination}
          // Last field in the row and hard against the panel's right edge, so
          // its list opens leftwards or it opens off the page.
          align="right"
        />
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

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
