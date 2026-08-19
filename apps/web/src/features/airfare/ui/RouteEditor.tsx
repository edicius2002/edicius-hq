import { useState, type FormEvent } from 'react';

import {
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  isAirportCode,
  isCalendarDate,
  isMonth,
  lastDayOf,
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
 * and the day inside it on the next because they are the other one; the button
 * last. Four inputs and a control, sized so the whole thing costs less vertical
 * room than two entries of the list it sits above — which is why the day went
 * beside the month rather than under it.
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
 * **The day beside the month is the focus date, and it is optional** — 12.130.
 * It does not change what is collected; the month still expands into every one
 * of its departures. It changes what the page reads, and it is what the
 * collector keeps first when the budget will not stretch to all of them.
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
  const [day, setDay] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The earliest month still worth watching is the one we are in: some of its
  // days have gone, but the rest have not, and the collector skips the gone
  // ones by name.
  const thisMonth = monthOf(today);
  const dayBounds = isMonth(month) ? { min: `${month}-01`, max: lastDayOf(month) } : null;

  /**
   * Moving the month takes the day with it.
   *
   * A day left standing from the month before is the one state the invariant
   * cannot survive — and it would be a *silent* break, because `type="date"`
   * shows `09/03/2027` the same way whichever month is picked above it. The
   * value is cleared rather than shifted into the new month: the 9th of March
   * is not evidence about April, and guessing is what the normalizer's own
   * rule forbids.
   */
  function changeMonth(next: string) {
    setMonth(next);
    if (day && monthOf(day) !== next) setDay('');
  }

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
    /*
     * The day is optional, so an empty one is not an error — but a day that
     * was typed and cannot be kept is. The normalizer would drop it and leave
     * a route that looked added and quietly was not what was asked for, which
     * is the same silence the month guard above exists to break.
     */
    if (day && (!isCalendarDate(day) || monthOf(day) !== month)) {
      setError('That day is not in the departure month.');
      return;
    }
    if (day && day < today) {
      setError('That day has gone.');
      return;
    }

    onAdd({
      origin: normalizeCode(origin),
      destination: normalizeCode(destination),
      month,
      ...(day ? { focusDate: day } : {}),
      currency: DEFAULT_CURRENCY,
    });

    setDestination('');
    setMonth('');
    setDay('');
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
        Back into a `.row` pair, and with the field that 12.113 emptied the
        other half of now filled by something that belongs there: the month and
        the day inside it are one decision about when to fly, the way the two
        airports above are one decision about where.

        Measured before it was moved, because a half-width control that
        overflows is worse than a full-width one that does not. `tokens.css`
        sets `--font-size-base: 125%`, so a rem is 20px. The panel column is
        `minmax(20rem, 27rem)`; at the 27rem ceiling that is 540px, less 2px of
        border and 2 x `--space-4` (20px) of padding, leaving 498px — two
        columns of 244px with the row's `--space-2` (10px) between them. At the
        20rem floor it is 358px of content and 174px a column. A native
        `type="month"` or `type="date"` at this 0.9rem (18px) draws `March 2027`
        or `09/03/2027` — ten characters, 108px at the 0.6em advance this font
        stack uses — plus a picker button of about 20px, 24px of padding and 2px
        of border: 154px, inside 174px at the floor and comfortable at the
        ceiling. The `min-width: 8rem` these inputs carry for the full-width
        case is what would have broken it, and it is dropped inside a row.
      */}
      <div className={styles.row}>
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
            onChange={(event) => changeMonth(event.target.value)}
          />
        </div>

        {/*
          The day inside that month, and it is allowed to stay empty — 12.130.
          A route with no focus is the ordinary case and the month above is what
          actually gets collected; this only says which of its departures the
          reader means to take, which is what the detail, the chart and the
          table then speak about, and which one survives when the day's request
          budget will not cover thirty-one.

          `type="date"` for the same reason the month is `type="month"`: its
          value is already the stored `YYYY-MM-DD`, so nothing here parses a
          date and nothing can shift one. `min` and `max` are the watched
          month's own two ends, so the picker cannot offer a day outside it —
          the browser enforcing the invariant that `readingPrefix` depends on,
          with the submit guard behind it for a browser that degrades this to a
          text box. Disabled until there is a month to be inside, because a
          bounded control with no bounds yet is one that accepts anything.

          "optional" is in the label rather than in a note underneath: a note
          costs a line of a form measured to fit above the list, and a label is
          what a screen reader reads before the field either way.
        */}
        <div className={styles.field}>
          <label htmlFor="airfare-focus">Day (optional)</label>
          <input
            id="airfare-focus"
            type="date"
            value={day}
            min={dayBounds?.min}
            max={dayBounds?.max}
            disabled={dayBounds === null}
            onChange={(event) => setDay(event.target.value)}
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
