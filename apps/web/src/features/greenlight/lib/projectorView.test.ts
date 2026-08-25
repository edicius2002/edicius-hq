import { describe, expect, it } from 'vitest';

import {
  NO_PROJECTOR_VIEW,
  capitalToStore,
  normalizeProjectorView,
  setProjectorCapital,
} from '@/features/greenlight/lib/projectorView';

/**
 * What the projector is allowed to remember, and what it refuses to.
 *
 * The rule the whole file turns on is that `capital: null` is not "empty" — it
 * is "follow the page's net". So every value that is not a number a projection
 * could start from has to normalize to null rather than to an empty string,
 * because an empty string would be a capital the reader chose and would beat
 * the net forever.
 */

describe('reading a stored projector view', () => {
  it('keeps a capital verbatim, comma decimal and all', () => {
    // Not round-tripped through a number: `parseAmount('2000,50')` is 2000.5 and
    // `amountToInput` writes it back as `2000,5`, so a reader who typed a
    // trailing zero would find it deleted the next time they opened the page.
    expect(normalizeProjectorView({ version: 1, capital: '2000,50' })).toEqual({
      version: 1,
      capital: '2000,50',
    });
  });

  it('reads nothing at all out of a document that is not one', () => {
    expect(normalizeProjectorView(null)).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView('20377,8')).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView([])).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView({})).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView({ version: 1, capital: 20377.8 })).toBe(NO_PROJECTOR_VIEW);
  });

  it('falls back to the page for a stored string no projection could start from', () => {
    // A field left holding a minus sign is a half-typed number, and one holding
    // spaces is a field somebody cleared. Neither is a capital, and restoring
    // either would leave the section printing "Nothing compounds from zero"
    // with no visible reason for it.
    expect(normalizeProjectorView({ version: 1, capital: '' })).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView({ version: 1, capital: '   ' })).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView({ version: 1, capital: '-' })).toBe(NO_PROJECTOR_VIEW);
    expect(normalizeProjectorView({ version: 1, capital: 'twenty thousand' })).toBe(
      NO_PROJECTOR_VIEW,
    );
  });

  it('keeps a zero and a negative, which are numbers the projector then refuses', () => {
    // The field remembers what was typed; whether it is worth projecting is the
    // projector's question and it already answers it with the empty-state note.
    expect(normalizeProjectorView({ version: 1, capital: '0' }).capital).toBe('0');
    expect(normalizeProjectorView({ version: 1, capital: '-5000' }).capital).toBe('-5000');
  });
});

describe('deciding what a typed field is worth storing', () => {
  it('stores a number and nulls everything else', () => {
    expect(capitalToStore('1000')).toBe('1000');
    expect(capitalToStore('2000,50')).toBe('2000,50');
    expect(capitalToStore('')).toBeNull();
    expect(capitalToStore('  ')).toBeNull();
    expect(capitalToStore('-')).toBeNull();
  });
});

describe('writing a capital into the view', () => {
  it('answers the same object when nothing moved, so a keystroke that changed nothing is not a write', () => {
    const view = { version: 1, capital: '1000' } as const;
    expect(setProjectorCapital(view, '1000')).toBe(view);
    expect(setProjectorCapital(NO_PROJECTOR_VIEW, null)).toBe(NO_PROJECTOR_VIEW);
  });

  it('records a new capital, and records the way back to the page', () => {
    expect(setProjectorCapital(NO_PROJECTOR_VIEW, '1000')).toEqual({ version: 1, capital: '1000' });
    expect(setProjectorCapital({ version: 1, capital: '1000' }, null)).toEqual({
      version: 1,
      capital: null,
    });
  });
});
