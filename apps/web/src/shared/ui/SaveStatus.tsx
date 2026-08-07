import { useEffect, useState } from 'react';

import type { SaveState } from '@/shared/storage/useStoredDocument';
import { Button } from '@/shared/ui/Button';

import styles from './SaveStatus.module.css';

const LABELS: Record<SaveState, string> = {
  loading: 'Loading…',
  idle: 'Saved',
  pending: 'Pending…',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Save failed',
  blocked: 'Reload to save',
};

/** Long enough to be read, short enough not to become the resting state. */
const SETTLE_MS = 2200;

export type SaveStatusProps = {
  state: SaveState;
  /** Offered on a failed write only. A blocked one needs a reload, not a retry. */
  onRetry?: () => void;
};

/**
 * What storage is doing, in a line.
 *
 * `pending` earns its place here: with a debounce in front of the writes there
 * is a window in which your work exists only in memory, and saying nothing
 * during it would be the dishonest part of having one.
 */
export function SaveStatus({ state, onRetry }: SaveStatusProps) {
  /*
   * "Saved" is news for a moment and clutter afterwards, so it fades back to
   * idle instead of sitting there taking credit for an edit made minutes ago.
   * Ported from the legacy, timing included.
   */
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (state !== 'saved') {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const shown: SaveState = state === 'saved' && settled ? 'idle' : state;

  return (
    <div className={styles.wrapper}>
      <span className={styles.status} data-state={shown} role="status">
        {LABELS[shown]}
      </span>

      {state === 'failed' && onRetry ? (
        <Button variant="ghost" className={styles.retry} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
