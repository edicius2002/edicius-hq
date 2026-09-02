import { useEffect, useRef, useState } from 'react';

import {
  GREENLIGHT_PROJECTOR_KEY,
  NO_PROJECTOR_VIEW,
  capitalToStore,
  normalizeProjectorView,
  setProjectorCapital,
  type ProjectorView,
} from '@/features/greenlight/lib/projectorView';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

export type ProjectorCapital = {
  /** What the Capital field shows. */
  capitalText: string;
  /** Record a keystroke. Persisting it is this hook's business, not the caller's. */
  setCapitalText: (text: string) => void;
  /** True while the stored answer is still unknown, so the field is blank. */
  isFetching: boolean;
};

/**
 * The Capital field's value, which outlives the component that shows it.
 *
 * Three questions had to be answered together, because each one's answer is
 * only safe given the others:
 *
 * - **Who wins.** `typed ?? stored ?? net`. The page's net is the starting
 *   figure and nothing more: once somebody has typed a capital it is theirs,
 *   and a later net — a fresh CSV, a marker moved — does not take it back.
 *   Emptying the field is the way out and the only one, because an empty field
 *   stores null and null *is* "follow the page".
 * - **What the field shows before the read lands.** Nothing. The net is
 *   available synchronously and the stored capital is not, so showing the net
 *   first would put a figure on screen that was never the answer and then
 *   replace it. A blank field is not a wrong number; $20,377.80 turning into
 *   $1,000 half a second later is. It is also the same blank the field already
 *   shows while Greenlight's own document loads, which is the usual case.
 * - **What a late read may not do.** Overwrite typing. Nothing is ever copied
 *   from storage into local state — the stored value is one branch of an
 *   expression that `typed` already beats — so a read that resolves during a
 *   keystroke has no way to win. The write is what needs the care instead: it
 *   is fired from an effect that also runs when the read settles, so a capital
 *   typed into the blank field before the store was readable is still sent once
 *   it becomes readable, rather than being dropped by the facade's refusal to
 *   write over a document it has not read.
 */
export function useProjectorCapital(netText: string): ProjectorCapital {
  const store = useStoredDocument<ProjectorView>({
    key: GREENLIGHT_PROJECTOR_KEY,
    normalize: normalizeProjectorView,
    placeholder: NO_PROJECTOR_VIEW,
  });

  const [typed, setTyped] = useState<string | null>(null);

  /*
   * Latched rather than read from `isFetching` each render: a background
   * refetch turns that back on, and a field that blanked itself mid-typing
   * because the window regained focus would be worse than anything this fixes.
   */
  const [known, setKnown] = useState(false);
  if (!known && !store.isFetching) setKnown(true);

  // The store object is rebuilt every render, so it is held rather than
  // depended on: the effect below has to fire on a keystroke and on the read
  // settling, and on nothing else.
  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  });

  useEffect(() => {
    if (!known || typed === null) return;
    const capital = capitalToStore(typed);
    void storeRef.current
      .edit((view) => setProjectorCapital(view, capital))
      .catch(() => {
        // The read failed, so the facade refuses to write rather than putting an
        // empty document over a real one. Swallowed rather than surfaced: the
        // field still works for this visit and only forgets, which is exactly
        // what it did before it remembered anything, and a projector that
        // interrupted a page whose own document is loading fine would be
        // reporting a failure the reader cannot act on.
      });
  }, [known, typed]);

  return {
    capitalText: typed ?? (known ? (store.data.capital ?? netText) : ''),
    setCapitalText: setTyped,
    isFetching: !known,
  };
}
