import { useState, type FormEvent } from 'react';

import {
  collectableYears,
  DEFAULT_CURRENCY,
  DEFAULT_ORIGIN,
  formatFlightMonth,
  isAirportCode,
  monthOf,
  nextMonth,
  normalizeCode,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import {
  beyondHorizon,
  monthChips,
  monthsElsewhere,
  refusalText,
  staleText,
} from '@/features/airfare/lib/monthChips';
import { describeCost, passCost } from '@/features/airfare/lib/passCost';
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

/** The label the departure controls share, as an id the group points at. */
const DEPARTING_LABEL_ID = 'airfare-departing-label';

type RouteEditorProps = {
  /** Today, `YYYY-MM-DD`. Passed in rather than read, so tests do not drift. */
  today: string;
  /** The watch loaded into the form, or null while it is adding. */
  editing: FareRoute | null;
  /** Every pair already watched, as ids, so a collision is named rather than swallowed. */
  watched: readonly string[];
  onAdd: (route: FareRoute) => void;
  onSave: (id: string, route: FareRoute) => void;
};

/**
 * The fields that add a route **and edit one**, always on screen at the top of
 * the watchlist.
 *
 * **Two rows for the pair and a strip for the months** — 12.265 as 12.268
 * revised it, plus `a-watch-is-a-pair-and-its-months`. The airports share the
 * first row, as they always did, because they are one decision.
 *
 * **The departure is a set of months, picked as twelve chips** — superseding
 * the month-and-year dropdown pair 12.262 introduced. A watch holds several
 * months now, and a dropdown that names one at a time can neither show a
 * reader which months they are watching nor let them change their mind about
 * one. Twelve cells, six across and two down, always visible: the strip is the
 * same in both modes and only what is pressed differs.
 *
 * **One form for adding and editing**, the way `PositionForm` is one form for
 * both — `const adding = editing === null`, and everything branches off that
 * one word. There is no dialog, because this app has none: *"edited in place,
 * because a dialog for a position is a dialog too many."*
 *
 * **The airports stay live while editing.** Changing the pair is a real edit
 * and the form warns about it rather than locking it: the archive is keyed by
 * city pair, so the new pair reads a different file and the charts start empty
 * — which is a thing to be told before pressing Save, not discovered after.
 *
 * **The years still come from the horizon** — 12.263. The strip is one calendar
 * year at a time and a selection is not, so the year control chooses which
 * twelve cells are drawn and `monthsElsewhere` says how many are in the other
 * one. Twelve chips cannot cover a 330-day horizon by themselves.
 *
 * **Twelve are always drawn and one outside the horizon is refused by name** —
 * 12.264 and 12.184, both kept, and `monthChips` records why disabling a chip
 * does not reintroduce the hazard 12.264 refused.
 *
 * **Return is gone and is not coming back as a date** — 12.113.
 *
 * It validates before it submits rather than letting the normalizer drop a bad
 * entry silently: a route that vanishes on save looks like a broken button, and
 * the reader has no way to learn which field was the problem.
 */
export function RouteEditor({ today, editing, watched, onAdd, onSave }: RouteEditorProps) {
  const adding = editing === null;

  const [origin, setOrigin] = useState(editing?.origin ?? DEFAULT_ORIGIN);
  const [destination, setDestination] = useState(editing?.destination ?? '');
  /*
   * Whole `YYYY-MM` strings, never bare month numbers, and that is what lets a
   * selection span two years while the strip shows one. It is also why moving
   * the year cannot un-pick anything: a cell names a month outright rather than
   * combining with a control beside it.
   */
  const [months, setMonths] = useState<string[]>(() =>
    editing ? [...editing.months] : [nextMonth(today)],
  );
  /* View state of the strip alone. It is never submitted. */
  const [year, setYear] = useState(() => (editing?.months[0] ?? nextMonth(today)).slice(0, 4));
  const [error, setError] = useState<string | null>(null);

  const thisMonth = monthOf(today);
  const years = collectableYears(today);
  const chips = monthChips(year, months, today);
  const elsewhere = monthsElsewhere(months, year);
  const cost = passCost(months, today);
  const costMessage = describeCost(cost);

  const pair = { origin: normalizeCode(origin), destination: normalizeCode(destination) };
  const nextId = routeId(pair);
  const editingId = editing ? routeId(editing) : null;
  const pairChanged = editing !== null && nextId !== editingId;
  /* Months the reader has taken off a watch that had them. */
  const dropped = editing ? editing.months.filter((month) => !months.includes(month)) : [];

  function toggle(month: string) {
    setMonths((held) =>
      held.includes(month)
        ? held.filter((candidate) => candidate !== month)
        : [...held, month].sort(),
    );
    setError(null);
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
    /*
     * A pair already watched. Refused here rather than left to the transitions,
     * which answer it by merging — merging is the right answer to give, and it
     * is the wrong thing to do to a reader without asking, because the row they
     * were editing disappears into another one.
     */
    if (nextId !== editingId && watched.includes(nextId)) {
      setError(
        adding
          ? `${routeLabel(pair)} is already watched. Select it to add months.`
          : `${routeLabel(pair)} is already watched. Add its months to that route instead.`,
      );
      return;
    }
    if (months.length === 0) {
      setError('Pick at least one departure month.');
      return;
    }

    const gone = months.filter((month) => month < thisMonth);
    if (gone.length === months.length) {
      setError(gone.length === 1 ? 'That month has gone.' : 'Those months have gone.');
      return;
    }
    /*
     * A month behind this one has no collectable departure left in it. Months
     * the watch **already held** are exempt: the calendar walks past a watched
     * month while the reader is not looking, and refusing the whole save for a
     * month they did not touch would make a route uneditable forever exactly
     * when they came to add the next one. A newly pressed past month is still
     * refused — the strip disables those cells, but a `disabled` attribute is
     * an affordance and not a guarantee, because the year rolls at midnight.
     */
    const newlyGone = gone.filter((month) => !editing?.months.includes(month));
    if (newlyGone.length > 0) {
      setError('That month has gone.');
      return;
    }
    /*
     * Refused here rather than accepted and dropped later — 12.264. A month
     * past the horizon is not a route that collects slowly, it is one the
     * provider answers nothing about. The message names the last day that
     * works, because "too far" without a number leaves the reader guessing at a
     * bound they cannot see — 12.184 — and then names which months are past it,
     * because a strip of twelve gives them no way to tell.
     */
    const past = beyondHorizon(months, today);
    if (past.length > 0) {
      setError(
        `${refusalText('beyond-horizon', today)} ${past.map(formatFlightMonth).join(' and ')} ${
          past.length === 1 ? 'is' : 'are'
        } past it.`,
      );
      return;
    }

    const next: FareRoute = {
      ...pair,
      months: [...months].sort(),
      currency: editing?.currency ?? DEFAULT_CURRENCY,
    };

    if (editing && editingId) {
      onSave(editingId, next);
      // Nothing is reset: the reader is still standing on that watch and the
      // fields still show it.
      setError(null);
      return;
    }

    onAdd(next);
    setDestination('');
    // Back to next month rather than to whatever was just added: leaving the
    // strip on the months that were added invites a second watch on the same
    // months by a reader who only changed the destination.
    setMonths([nextMonth(today)]);
    setYear(nextMonth(today).slice(0, 4));
    setError(null);
  }

  return (
    <form
      id={ADD_ROUTE_FORM_ID}
      className={styles.form}
      onSubmit={submit}
      aria-label={editing ? `Edit the watch on ${routeLabel(editing)}` : 'Add a route to watch'}
    >
      {/*
        The two airports on one row, and the row is also what their suggestion
        lists hang from — 12.268.

        `subgrid` rather than a grid of its own, so the four tracks are the
        form's own: "Origin" and "Departing" share the first column and their
        fields start at the same x, which a nested grid measuring its own
        labels could not manage.
      */}
      <div className={styles.airports}>
        <AirportField
          id="airfare-origin"
          label="Origin"
          value={origin}
          placeholder="LIM"
          onChange={setOrigin}
          align="left"
          layout="inline"
        />
        <AirportField
          id="airfare-destination"
          label="Destination"
          value={destination}
          placeholder="SCL"
          onChange={setDestination}
          align="right"
          layout="inline"
        />
      </div>

      {/*
        One visible label over the year control and the strip both, so it is a
        group rather than a `<label>`: `htmlFor` names exactly one control, and
        pointing it at any single chip would leave the other twelve unlabelled.
        Every control underneath carries its own accessible name.
      */}
      <span className={styles.groupLabel} id={DEPARTING_LABEL_ID}>
        Departing
      </span>

      <div className={styles.year}>
        {/*
          Two digits, which is what the owner reads a year as here. The `value`
          stays the full `YYYY` — the stored months are built from it, and a
          two-digit value would be a century nobody stated.
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
        {/*
          What the strip on screen is not showing. Without it a reader on 26 who
          has picked March 2027 sees twelve unpressed chips and a form that
          looks empty.
        */}
        {elsewhere ? <span className={styles.elsewhere}>{elsewhere}</span> : null}
      </div>

      {/*
        Twelve cells, six across and two down — a row is half a year, and it
        costs one row of height less than the four-by-three a calendar year
        suggests. Plain buttons in document order rather than a roving tabindex:
        these are twelve independent toggles, not one choice, and every one is a
        control a reader may want to reach with Tab. The same bargain
        `IndicatorBar` makes for seven.
      */}
      <div className={styles.months} role="group" aria-labelledby={DEPARTING_LABEL_ID}>
        {chips.map((chip) => (
          <button
            key={chip.month}
            type="button"
            className={[
              styles.monthChip,
              chip.selected ? styles.monthChipOn : '',
              chip.selected && chip.month < thisMonth ? styles.monthChipStale : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={chip.label}
            aria-pressed={chip.selected}
            disabled={chip.refusal !== null}
            title={
              chip.refusal !== null
                ? refusalText(chip.refusal, today)
                : chip.selected && chip.month < thisMonth
                  ? staleText(chip.month)
                  : undefined
            }
            onClick={() => toggle(chip.month)}
          >
            {chip.short}
          </button>
        ))}
      </div>

      {/*
        A routine estimate does not alter the choice, but the collector cannot
        surface a pass it had to drop. Keep that consequence visible here.
      */}
      {costMessage ? (
        <p className={cost.overrun ? styles.costLoud : styles.cost} aria-live="polite">
          {costMessage}
        </p>
      ) : null}

      {/*
        Warnings rather than refusals, and in a `status` region of their own so
        a screen reader is not interrupted by something the reader can act on at
        leisure — the `alert` node below stays reserved for what stops a save.
        Both are stated the moment the field differs, not after Save: afterwards
        the chart is already blank and the reader is working out what they broke.
      */}
      <div className={styles.notes} role="status">
        {pairChanged ? (
          <p className={styles.note}>
            Saving this changes the pair to {routeLabel(pair)}. Everything collected for{' '}
            {routeLabel(editing)} stays on disk under that pair, but this watch stops reading it and
            the charts start empty until {routeLabel(pair)} has collected.
          </p>
        ) : null}
        {dropped.length > 0 ? (
          <p className={styles.note}>
            Dropping {dropped.map(formatFlightMonth).join(' and ')} stops collecting{' '}
            {dropped.length === 1 ? 'it' : 'them'}. Everything already collected stays on disk.
          </p>
        ) : null}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
