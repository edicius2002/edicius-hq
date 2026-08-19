import { useState, type FormEvent } from 'react';

import {
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  formatFlightDate,
  isAirportCode,
  isCalendarDate,
  lastCollectableDay,
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
 * Origin and destination on one row because they are one decision; the
 * departure date on the next because it is the other one; the button last.
 * Three inputs and a control, sized so the whole thing costs less vertical
 * room than two entries of the list it sits above.
 *
 * **One date, and the month is derived from it** — 12.180, superseding the
 * two-control arrangement 12.130 shipped. The reader is asked the question
 * they actually have an answer to: the day they mean to fly. `monthOf` turns
 * that into the watch, and the month is still the whole of what is collected —
 * all thirty-one of its departures, unchanged. The date itself becomes the
 * focus, which is what the detail panel, the chart and the flight table read,
 * and what the collector keeps first when a pass cannot afford every departure
 * it is watching.
 *
 * So every route added here has a focus, and that is a reversal of 12.130's
 * "absent is the ordinary case" rather than a drift away from it. It is
 * argued in 12.180 and the supersede row beside it. Absent is still a shape
 * the model and the whole page handle, because two things still produce it: a
 * route stored before this change, and a reader who pressed "Read the whole
 * month" in the detail panel — which is now the only way back, 12.182.
 *
 * **Return is gone and is not coming back as a date** — 12.113. A return date
 * belongs to one departure, and a month has thirty-one; the owner has put
 * return legs out of scope, and when they return they will return as a number
 * of nights rather than a second date.
 *
 * The airport comboboxes are untouched.
 *
 * It validates before it submits rather than letting the normalizer drop a bad
 * entry silently: a route that vanishes on save looks like a broken button,
 * and the reader has no way to learn which field was the problem.
 */
export function RouteEditor({ onAdd, today }: RouteEditorProps) {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState('');
  const [departure, setDeparture] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The two ends of what can be collected at all. Today is included: a
  // departure zero days out is inside the horizon and the collector polls it
  // at the fastest rate it has. The far end is measured, not chosen — see
  // `COLLECTABLE_HORIZON_DAYS`.
  const lastDay = lastCollectableDay(today);

  /*
   * There is no second control to keep in step, and that is the point.
   *
   * The arrangement this replaces had a month above a day, and the state it
   * could not survive was a day left standing when the month moved out from
   * under it — a *silent* break, because `type="date"` renders `09/03/2027`
   * identically whichever month is picked above it, so a reader looking at the
   * form could not see that the two disagreed. It was guarded by clearing the
   * day on every month change.
   *
   * A guard is weaker than an impossibility. With one field the month is a
   * function of the date, recomputed at submit from the value being submitted,
   * so there is no second value that can be stale and nothing to keep in step.
   * The one thing that must not be lost with the guard is *why* it existed:
   * whatever this form grows next, the month and the focus must never be two
   * independently editable values, because a date control cannot show which
   * month it belongs to and the disagreement would go unseen.
   */
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
    /*
     * The date is required, and it is required here rather than by a `required`
     * attribute on the control. A native constraint stops the submit event
     * from firing at all and answers with the browser's own bubble, which
     * would make this the one field in the form whose complaint arrives in a
     * different place, in a different voice, and — because it pre-empts the
     * event — ahead of the airport checks above it. One `role="alert"`, in
     * document order, for every reason this form can refuse.
     *
     * The `min` and `max` guards below are declared on the control as well,
     * and repeated here on purpose: the attributes stop a bad value being
     * *picked*, and this stops one being *submitted* in a browser that
     * degrades `type="date"` to a text box and enforces neither.
     */
    if (departure === '') {
      setError('Pick the day you mean to fly.');
      return;
    }
    if (!isCalendarDate(departure)) {
      setError('Departure date must be a real date.');
      return;
    }
    if (departure < today) {
      setError('That day has gone.');
      return;
    }
    /*
     * Refused here rather than accepted and dropped later. A departure past
     * the horizon is not a route that collects slowly, it is one the provider
     * answers nothing about — it would sit in the watchlist reporting
     * `beyond-horizon` on every pass forever, and nothing on screen would tell
     * the reader that the date was the reason.
     */
    if (departure > lastDay) {
      setError(`Fares are only on sale as far ahead as ${formatFlightDate(lastDay)}.`);
      return;
    }

    onAdd({
      origin: normalizeCode(origin),
      destination: normalizeCode(destination),
      // Derived, never stored beside the date as a second editable value.
      month: monthOf(departure),
      focusDate: departure,
      currency: DEFAULT_CURRENCY,
    });

    setDestination('');
    setDeparture('');
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

      <div className={styles.field}>
        <label htmlFor="airfare-departure">Departure date</label>
        {/*
          `type="date"` rather than three selects or a text box: its value is
          already the stored `YYYY-MM-DD`, so nothing here ever parses a date
          and nothing can shift one the way `new Date('2027-03-09')` shifts it
          west of Greenwich — it is midnight UTC, which prints as the 8th in
          Lima.

          Full width now that it is the only field on its row. The `min-width:
          8rem` these inputs carry is 160px plus 26px of chrome, against the
          358px of content the panel has at its 20rem floor: it fits with room
          to spare, which is why the override the two-column arrangement needed
          is gone rather than kept for a case that no longer exists.

          `min` and `max` are the ends of what can be collected, so the picker
          itself will not offer a day that has gone or one the provider refuses
          to answer about. Both are repeated in the submit guard for a browser
          that degrades this to a text box and enforces neither. There is no
          `required` beside them, and the reason is in `submit`.
        */}
        <input
          id="airfare-departure"
          type="date"
          value={departure}
          min={today}
          max={lastDay}
          onChange={(event) => setDeparture(event.target.value)}
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
