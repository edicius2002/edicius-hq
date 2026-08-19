import { useState, type FormEvent } from 'react';

import {
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  isAirportCode,
  isMonth,
  monthOf,
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
 * Origin and destination on one row because they are one decision; the month
 * below them because it is the next one; the button last. Three inputs and a
 * control, sized so the whole thing costs less vertical room than two entries
 * of the list it sits above.
 *
 * **The Departure field is a month, and Return is gone** — 12.110 and 12.113.
 * The month is what the watch is now: the collector expands it into its
 * departures, so asking for one day here would be asking the reader to choose
 * the thing the page exists to work out for them. Return went with it because
 * a return date belongs to one departure, and a month has thirty-one — one
 * shared return would be thirty wrong trips, and a return that moved with each
 * departure would be a trip *length*, which is a different product. The owner
 * has put return legs out of scope; when they come back they will come back as
 * a length, and this form will grow a number of nights rather than a date.
 *
 * The airport comboboxes are untouched.
 *
 * It validates before it submits rather than letting the normalizer drop a bad
 * entry silently: a route that vanishes on save looks like a broken button,
 * and the reader has no way to learn that `2026-13` was the problem.
 */
export function RouteEditor({ onAdd, today }: RouteEditorProps) {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState('');
  const [month, setMonth] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The earliest month still worth watching is the one we are in: some of its
  // days have gone, but the rest have not, and the collector skips the gone
  // ones by name.
  const thisMonth = monthOf(today);

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
    if (!isMonth(month)) {
      setError('Departure month must be a real month.');
      return;
    }
    if (month < thisMonth) {
      setError('That month is over.');
      return;
    }

    onAdd({
      origin: normalizeCode(origin),
      destination: normalizeCode(destination),
      month,
      currency: DEFAULT_CURRENCY,
    });

    setDestination('');
    setMonth('');
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

      {/*
        On its own row rather than in a `.row` pair. There is no second date to
        stand beside it since 12.113 dropped the return leg, and a single field
        in a two-column grid is a half-width control with a hole next to it.
      */}
      <div className={styles.field}>
        <label htmlFor="airfare-departure">Departure month</label>
        {/*
          `type="month"` rather than a pair of selects: it is the one control
          whose value is already `YYYY-MM`, which is what is stored, so the form
          never converts and so never has a chance to shift a month the way
          `new Date('2027-03')` would west of Greenwich.

          A browser without it degrades to a text box that still takes
          `2027-03`, which the submit guard checks anyway. `min` is what stops
          a past month in a browser that has the control; the guard is what
          stops it in one that does not.
        */}
        <input
          id="airfare-departure"
          type="month"
          value={month}
          min={thisMonth}
          onChange={(event) => setMonth(event.target.value)}
        />
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
