import { parseAmount } from '@/shared/lib/money';
import type { StorageKey } from '@/shared/storage/keys';

/**
 * The compound projector's own field state, apart from the Greenlight document.
 *
 * Same rule as `finance-camera-views`: what the reader is looking at is not the
 * data they are looking at. Greenlight's document carries import modes and a
 * marker migration, and a CSV import rewrites weeks inside it — a projector
 * field has no business riding along in a schema that gets rebuilt.
 */
export const GREENLIGHT_PROJECTOR_KEY: StorageKey = 'greenlight-projector';

export type ProjectorView = {
  version: 1;
  /**
   * The capital as the reader typed it, verbatim — or null for "follow the
   * page's net", which is what an empty field means and what a fresh install
   * starts at.
   *
   * A string and not a number, because the field is a text field: `2000,50`
   * round-tripped through `parseAmount`/`amountToInput` comes back `2000,5`,
   * and a trailing zero the reader typed is not ours to delete. The rate is
   * deliberately not here — see the decision log.
   */
  capital: string | null;
};

export const NO_PROJECTOR_VIEW: ProjectorView = { version: 1, capital: null };

/**
 * What a typed field is worth storing as.
 *
 * Anything the projector could not start a projection from stores as null,
 * which is the same as never having typed: the field goes back to following the
 * page's net on the next visit. That covers the empty field — the deliberate
 * way out — and equally the half-typed `-` somebody walked away from, which
 * would otherwise be restored as a capital that projects nothing with no
 * visible reason for it.
 */
export function capitalToStore(text: string): string | null {
  return parseAmount(text) === null ? null : text;
}

/** A stored view that is damaged, or absent, is a field that follows the page. */
export function normalizeProjectorView(value: unknown): ProjectorView {
  if (!value || typeof value !== 'object') return NO_PROJECTOR_VIEW;
  const { capital } = value as { capital?: unknown };
  if (typeof capital !== 'string') return NO_PROJECTOR_VIEW;

  const kept = capitalToStore(capital);
  return kept === null ? NO_PROJECTOR_VIEW : { version: 1, capital: kept };
}

/** A keystroke that left the stored capital where it was does not make a document. */
export function setProjectorCapital(view: ProjectorView, capital: string | null): ProjectorView {
  if (view.capital === capital) return view;
  return { version: 1, capital };
}
