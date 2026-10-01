import { describe, expect, it } from 'vitest';
import { parseLatest, parseHistory, freshness, bestQuotes, readPreferences } from './model';
const now = Date.parse('2026-09-29T15:00:00Z');
const row = {
  owner_id: 'owner',
  source: 'kambista',
  observed_at: '2026-09-29T14:50:00Z',
  effective_at: '2026-09-29T14:50:00Z',
  buy: 3.712345,
  sell: 3.73,
  context: {},
};
describe('FX contract and presentation', () => {
  it('preserves numeric precision and rejects malformed/null/inverted prices', () => {
    expect(parseLatest([row])[0].buy).toBe(3.712345);
    for (const value of [
      null,
      {},
      [{ ...row, buy: null }],
      [{ ...row, buy: 4 }],
      [{ ...row, source: 'unknown' }],
      [{ ...row, observed_at: 'yesterday' }],
    ])
      expect(() => parseLatest(value)).toThrow();
  });
  it('rejects wrong-source histories and invalid aggregation', () => {
    expect(
      parseHistory({ points: [row], aggregation: 'observations' }, 'kambista').points,
    ).toHaveLength(1);
    expect(() => parseHistory({ points: [row], aggregation: 'daily' }, 'sbs')).toThrow();
    expect(() => parseHistory({ points: [], aggregation: 'weekly' }, 'sbs')).toThrow();
  });
  it('distinguishes capture age from reference effective age', () => {
    expect(freshness(parseLatest([row])[0], now)).toBe('Fresh');
    expect(freshness(parseLatest([{ ...row, observed_at: '2026-09-29T14:45:00Z' }])[0], now)).toBe(
      'Fresh',
    );
    expect(freshness(parseLatest([{ ...row, observed_at: '2026-09-29T14:44:59Z' }])[0], now)).toBe(
      'Stale',
    );
    expect(freshness(parseLatest([{ ...row, observed_at: '2026-09-29T14:00:00Z' }])[0], now)).toBe(
      'Stale',
    );
    expect(
      freshness(
        parseLatest([{ ...row, source: 'bcrp', effective_at: '2026-09-25T05:00:00Z' }])[0],
        now,
      ),
    ).toBe('Fresh');
    expect(
      freshness(
        parseLatest([{ ...row, source: 'sbs', effective_at: '2026-09-20T05:00:00Z' }])[0],
        now,
      ),
    ).toBe('Stale');
  });
  it('excludes stale and reference quotes from independent buy/sell rankings', () => {
    const rows = parseLatest([
      row,
      { ...row, source: 'rextie', buy: 3.7, sell: 3.72 },
      { ...row, source: 'sbs', buy: 3.72, sell: 3.72 },
      { ...row, source: 'securex', buy: 3.72, observed_at: '2026-09-20T00:00:00Z' },
    ]);
    expect(bestQuotes(rows, now)).toEqual({ buy: 3.712345, sell: 3.72 });
  });
  it('safely restores valid source/range/favorites and rejects corrupt storage', () => {
    expect(readPreferences('{')).toEqual({ source: 'kambista', range: '7D', favorites: [] });
    expect(
      readPreferences(JSON.stringify({ source: 'sbs', range: 'ALL', favorites: ['sbs', 'bad'] })),
    ).toEqual({ source: 'sbs', range: 'ALL', favorites: ['sbs'] });
  });
});
