import { describe, expect, it } from 'vitest';

import {
  INDICATOR_IDS,
  NO_INDICATORS,
  activePanes,
  isActive,
  normalizeIndicators,
  toggle,
} from '@/features/investing/data/indicators';

describe('normalizeIndicators', () => {
  it('starts with nothing on', () => {
    // A chart that opened covered in lines would be a worse default than one
    // you have to ask.
    expect(normalizeIndicators(undefined)).toEqual(NO_INDICATORS);
    expect(normalizeIndicators(null)).toEqual(NO_INDICATORS);
    expect(normalizeIndicators('rsi')).toEqual(NO_INDICATORS);
    expect(normalizeIndicators({})).toEqual(NO_INDICATORS);
  });

  it('keeps the ids it recognises and drops the rest', () => {
    // An unknown id would be drawn by nothing, and would come back to life if
    // the name were ever reused for something else.
    const out = normalizeIndicators({ active: ['rsi', 'bogus', 'macd'] });

    expect(out.active).toEqual(['rsi', 'macd']);
  });

  it('reads them back in the canonical order, whatever order they were stored', () => {
    const out = normalizeIndicators({ active: ['macd', 'sma', 'rsi'] });

    expect(out.active).toEqual(['sma', 'rsi', 'macd']);
  });
});

describe('toggle', () => {
  it('turns one on and off again', () => {
    const on = toggle(NO_INDICATORS, 'rsi');
    expect(isActive(on, 'rsi')).toBe(true);

    expect(isActive(toggle(on, 'rsi'), 'rsi')).toBe(false);
  });

  it('leaves the others alone', () => {
    const both = toggle(toggle(NO_INDICATORS, 'rsi'), 'sma');

    expect(toggle(both, 'rsi').active).toEqual(['sma']);
  });

  it('keeps the canonical order however they were clicked', () => {
    // Otherwise the stored list would record the order of your clicks, and two
    // identical chart states would compare unequal.
    const clicked = toggle(toggle(toggle(NO_INDICATORS, 'macd'), 'sma'), 'rsi');

    expect(clicked.active).toEqual(INDICATOR_IDS.filter((id) => clicked.active.includes(id)));
    expect(clicked.active).toEqual(['sma', 'rsi', 'macd']);
  });
});

describe('activePanes', () => {
  it('reports only the ones that get a band of their own', () => {
    const all = INDICATOR_IDS.reduce(toggle, NO_INDICATORS);

    // Overlays live on the price scale; only these two take vertical room.
    expect(activePanes(all)).toEqual(['rsi', 'macd']);
  });

  it('is empty when only overlays are on', () => {
    expect(activePanes(toggle(NO_INDICATORS, 'sma'))).toEqual([]);
  });
});
