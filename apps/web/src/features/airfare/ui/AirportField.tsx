import { useEffect, useId, useRef, useState } from 'react';

import { searchAirports, type AirportMatch } from '@/shared/api/fares';

import styles from './AirportField.module.css';

/**
 * A three-letter code, typed or picked from what the server suggests.
 *
 * A real combobox rather than a `<datalist>`, and the reason is not polish: a
 * datalist filters its own options against the input's *value*, so an option
 * whose value is `MAD` disappears the moment someone types `madrid`. The one
 * search people most want is exactly the one the native control drops.
 *
 * So: `role="combobox"` with an owned listbox, arrow keys, Enter to take the
 * highlighted match, Escape to dismiss, and `aria-activedescendant` so a
 * screen reader follows the highlight. The field never *requires* a
 * suggestion — an airport the table has not heard of can still be typed and
 * watched, because the table is a convenience and the collector is the
 * authority.
 */

/** Long enough to have stopped typing, short enough not to feel laggy. */
const DEBOUNCE_MS = 160;

type AirportFieldProps = {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (code: string) => void;
  /**
   * Which edge of the field the list is pinned to; it grows away from that
   * edge. `right` opens it leftwards, which is what the field at the end of a
   * row needs.
   */
  align?: 'left' | 'right';
};

export function AirportField({
  id,
  label,
  value,
  placeholder,
  onChange,
  align = 'left',
}: AirportFieldProps) {
  const listId = useId();
  const [matches, setMatches] = useState<AirportMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  /*
   * The last value this field has already accounted for.
   *
   * Seeded with whatever it was given, so a field that arrives pre-filled —
   * origin always does — does not search on mount and pop a list open over the
   * map before anyone has typed. Updated when a suggestion is taken, so
   * accepting `MAD` does not immediately search for `MAD`.
   *
   * A "first run" flag would have been the obvious way to do this and would
   * have been wrong: StrictMode runs effects twice in development, the ref
   * survives the simulated remount, and the second run sails past the guard.
   * Comparing values has no such seam.
   */
  const settled = useRef(value);

  useEffect(() => {
    if (value === settled.current) return;
    settled.current = value;
    const query = value.trim();
    if (query.length < 2) {
      setMatches([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchAirports(query, { signal: controller.signal })
        .then((response) => {
          setMatches(response.matches);
          setActive(0);
          setOpen(response.matches.length > 0);
        })
        // An aborted or failed lookup leaves the field working — the code can
        // still be typed, and a suggestion box is not worth an error message.
        .catch(() => undefined);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  function take(match: AirportMatch) {
    settled.current = match.code;
    onChange(match.code);
    setOpen(false);
    setMatches([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      // Only swallow Enter when a suggestion is genuinely highlighted, so a
      // typed code still submits the form on the first press.
      event.preventDefault();
      take(matches[active]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.control}>
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          maxLength={3}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches.length ? `${listId}-${active}` : undefined}
        />

        {open && matches.length > 0 ? (
          <ul
            ref={listRef}
            className={align === 'right' ? `${styles.list} ${styles.leftwards}` : styles.list}
            id={listId}
            role="listbox"
            aria-label={`${label} suggestions`}
          >
            {matches.map((match, index) => (
              <li
                key={match.code}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? `${styles.option} ${styles.active}` : styles.option}
                // `mousedown` rather than `click`: blur fires first otherwise
                // and the list is gone before the click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  take(match);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className={styles.code}>{match.code}</span>
                <span className={styles.place}>
                  {match.city}
                  {match.country ? `, ${match.country}` : ''}
                </span>
                <span className={styles.name}>{match.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
