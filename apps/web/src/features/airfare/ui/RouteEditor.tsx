import { useState, type FormEvent } from 'react';

import {
  collectableYears,
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  formatFlightDate,
  isAirportCode,
  lastCollectableDay,
  lastCollectableMonth,
  monthOf,
  MONTH_NAMES,
  nextMonth,
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

/** The label the two departure dropdowns share, as an id the group points at. */
const DEPARTING_LABEL_ID = 'airfare-departing-label';

type RouteEditorProps = {
  onAdd: (route: FareRoute) => void;
  /** Today, `YYYY-MM-DD`. Passed in rather than read, so tests do not drift. */
  today: string;
};

/**
 * The fields that add a route, always on screen at the top of the watchlist.
 *
 * **Two rows, and every field sits beside its own label** — 12.265 as 12.268
 * revised it. The airports share the first row, as they always did, because
 * they are one decision; the departure has the second. What made that look
 * impossible was the input width rather than the labels: an 8rem minimum on a
 * field that holds three letters left the row 500-odd pixels wide against the
 * 358px this panel has at its 20rem floor. Three letters need 32px of text,
 * and the row now fits inside 358 with the pair at 63px each — see the
 * stylesheet, where the arithmetic is written out.
 *
 * **The departure is a month and a year, not a date** — 12.262, superseding
 * 12.180 and with it the focus that 12.130 introduced and this change removes
 * (12.260). The reader filling this in knows they are flying in September; the
 * date control asked them for the 9th, which is a precision they do not have
 * when they add the watch and which the whole page then narrowed itself onto.
 * A watched route is a city pair and a month again, so the form asks for a
 * city pair and a month.
 *
 * Both dropdowns default to **next month**, and the year rolls with it: from
 * December the default is January of the following year, which is why the
 * default comes from `nextMonth` rather than from two independent slices of
 * today. The month the reader is standing in is deliberately not the default —
 * its near days have gone and its far ones barely move — but it is still on
 * offer, because the year list starts at this year.
 *
 * **The years come from the horizon** — 12.263. `collectableYears` spans
 * today's year to the year the 330-day horizon lands in, which today is `26`
 * and `27` exactly. Typing those two in would be right until 2027 and then
 * quietly wrong.
 *
 * **All twelve months stay on offer and a combination outside the horizon is
 * refused by name** — 12.264, keeping 12.184. The dropdowns are not narrowed
 * against each other: picking August and then switching the year from 26 to 27
 * would have to un-pick the month, and a control that edits itself under the
 * reader is worse than one that says why it will not take what they chose.
 * Both halves are legible on screen the whole time, which is what the old
 * month-and-day pair could not manage.
 *
 * **Return is gone and is not coming back as a date** — 12.113. A return date
 * belongs to one departure, and a month has thirty-one; the owner has put
 * return legs out of scope, and when they return they will return as a number
 * of nights rather than a second date.
 *
 * It validates before it submits rather than letting the normalizer drop a bad
 * entry silently: a route that vanishes on save looks like a broken button,
 * and the reader has no way to learn which field was the problem.
 */
export function RouteEditor({ onAdd, today }: RouteEditorProps) {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState('');
  // One default, split into the two halves that show it. Derived from
  // `nextMonth` rather than from two reads of `today`, so December's roll
  // moves both at once and neither can be left behind.
  const [month, setMonth] = useState(() => nextMonth(today).slice(5, 7));
  const [year, setYear] = useState(() => nextMonth(today).slice(0, 4));
  const [error, setError] = useState<string | null>(null);

  // The two ends of what can be collected at all, as months. The current month
  // counts because its remaining days do; the far month counts because part of
  // it is inside the horizon and the collector says `beyond-horizon` by name
  // for the rest. The far end is measured, not chosen — see
  // `COLLECTABLE_HORIZON_DAYS`.
  const thisMonth = monthOf(today);
  const lastMonth = lastCollectableMonth(today);
  const years = collectableYears(today);

  /*
   * Two controls, and — unlike the pair this form used to have — they cannot
   * disagree.
   *
   * 12.185 made a month and a day unable to fall out of step, because
   * `type="date"` renders `09/03/2027` identically whichever month sat above
   * it and the disagreement was therefore *invisible*. That hazard was
   * redundancy: the day already stated its month, so two editable values named
   * one fact and one of them could be stale.
   *
   * A month and a year hold no redundancy at all. Neither states the other,
   * together they name exactly one `YYYY-MM`, and both are spelled out on
   * screen the whole time. There is no stale half to guard against — only a
   * combination that falls outside the horizon, which is a different thing and
   * is answered below in words.
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

    const departure = `${year}-${month}`;
    /*
     * A month behind this one has no collectable departure left in it: every
     * day of it comes back `departed` on every pass forever, and nothing on
     * screen would connect that to the dropdowns. Reachable because the year
     * list starts at this year, so January can be picked in August.
     */
    if (departure < thisMonth) {
      setError('That month has gone.');
      return;
    }
    /*
     * Refused here rather than accepted and dropped later, and refused rather
     * than prevented — 12.264. A month past the horizon is not a route that
     * collects slowly, it is one the provider answers nothing about; it would
     * sit in the watchlist reporting `beyond-horizon` on every pass with
     * nothing saying the month was the reason. The message names the last day
     * that works, because "too far" without a number leaves the reader
     * guessing at a bound they cannot see — 12.184.
     */
    if (departure > lastMonth) {
      setError(
        `Fares are only on sale as far ahead as ${formatFlightDate(lastCollectableDay(today))}.`,
      );
      return;
    }

    onAdd({
      origin: normalizeCode(origin),
      destination: normalizeCode(destination),
      month: departure,
      currency: DEFAULT_CURRENCY,
    });

    setDestination('');
    // Back to next month rather than to whatever was just added: a dropdown
    // has no empty state to return to, and leaving it on the month that was
    // added invites a second watch on the same month by a reader who only
    // changed the destination.
    setMonth(nextMonth(today).slice(5, 7));
    setYear(nextMonth(today).slice(0, 4));
    setError(null);
  }

  return (
    <form
      id={ADD_ROUTE_FORM_ID}
      className={styles.form}
      onSubmit={submit}
      aria-label="Add a route to watch"
    >
      {/*
        The two airports on one row, and the row is also what their suggestion
        lists hang from — 12.268.

        `subgrid` rather than a grid of its own, so the four tracks are the
        form's own: "Origin" and "Departing" share the first column and their
        fields start at the same x, which a nested grid measuring its own
        labels could not manage. The wrapper exists for two things at once —
        the row, and a `position: relative` for the lists, which inline fields
        hand to their caller.
      */}
      <div className={styles.airports}>
        <AirportField
          id="airfare-origin"
          label="Origin"
          value={origin}
          placeholder="LIM"
          onChange={setOrigin}
          // Pinned to this row's left edge, which is the form's — not to the
          // input, which sits a label column in from it.
          align="left"
          layout="inline"
        />
        <AirportField
          id="airfare-destination"
          label="Destination"
          value={destination}
          placeholder="SCL"
          onChange={setDestination}
          // Pinned to this row's right edge, so it grows leftwards. Opening
          // rightwards from a field hard against the panel's edge is how a
          // horizontal scrollbar arrives on this tab.
          align="right"
          layout="inline"
        />
      </div>

      {/*
        One visible label over two controls, so it is a group rather than a
        `<label>`: `htmlFor` names exactly one control, and pointing it at the
        month would leave the year unlabelled and the click target wrong. Each
        dropdown carries its own accessible name underneath the group's, which
        is what lets a screen-reader user hear "Departing, month, September"
        rather than two unnamed comboboxes.
      */}
      <span className={styles.groupLabel} id={DEPARTING_LABEL_ID}>
        Departing
      </span>
      <div className={styles.departure} role="group" aria-labelledby={DEPARTING_LABEL_ID}>
        <select
          id="airfare-departure-month"
          aria-label="Departure month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        >
          {MONTH_NAMES.map((name, index) => (
            <option key={name} value={String(index + 1).padStart(2, '0')}>
              {name}
            </option>
          ))}
        </select>
        {/*
          Two digits, which is what the owner reads a year as here and what
          keeps this control narrow enough to sit beside a nine-letter month
          inside a 400px panel. The `value` stays the full `YYYY` — the stored
          month is built from it, and a two-digit value would be a century
          nobody stated.
        */}
        <select
          id="airfare-departure-year"
          aria-label="Departure year"
          value={year}
          onChange={(event) => setYear(event.target.value)}
        >
          {years.map((offered) => (
            <option key={offered} value={String(offered)}>
              {String(offered).slice(2)}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
