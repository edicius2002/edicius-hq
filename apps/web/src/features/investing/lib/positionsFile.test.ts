import { describe, expect, it } from 'vitest';

import {
  createPositionsFile,
  mergeImportedPositions,
  positionsFilename,
  readPositionsFile,
} from '@/features/investing/lib/positionsFile';

describe('positions files', () => {
  it('round-trips the positions export envelope', () => {
    const exported = createPositionsFile(
      { version: 1, positions: [{ symbol: 'aapl', quantity: 2, averageCost: 190 }] },
      '2026-08-31T12:00:00.000Z',
    );

    const parsed = readPositionsFile(JSON.stringify(exported));

    expect(parsed).toEqual({
      ok: true,
      value: {
        positions: [{ symbol: 'AAPL', quantity: 2, averageCost: 190 }],
        discarded: 0,
      },
    });
    expect(positionsFilename(exported.exportedAt)).toBe('positions-2026-08-31.json');
  });

  it('also accepts the bare portfolio shape storage holds', () => {
    expect(
      readPositionsFile(
        JSON.stringify({
          version: 1,
          positions: [{ symbol: 'msft', quantity: 2, averageCost: 400 }],
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        positions: [{ symbol: 'MSFT', quantity: 2, averageCost: 400 }],
        discarded: 0,
      },
    });
  });

  it('merges imported positions by symbol without removing positions absent from the file', () => {
    const merged = mergeImportedPositions(
      {
        version: 1,
        positions: [
          { symbol: 'AAPL', quantity: 1, averageCost: 100 },
          { symbol: 'MSFT', quantity: 2, averageCost: 400 },
        ],
      },
      [
        { symbol: 'aapl', quantity: 1.5, averageCost: 120 },
        { symbol: 'NVDA', quantity: 3, averageCost: 170 },
      ],
    );

    expect(merged).toEqual({
      portfolio: {
        version: 1,
        positions: [
          { symbol: 'AAPL', quantity: 1.5, averageCost: 120 },
          { symbol: 'MSFT', quantity: 2, averageCost: 400 },
          { symbol: 'NVDA', quantity: 3, averageCost: 170 },
        ],
      },
      added: 1,
      updated: 1,
    });
  });

  it('rejects a JSON file that is not positions data', () => {
    expect(readPositionsFile(JSON.stringify({ app: 'edicius-hq', kind: 'finance' }))).toEqual({
      ok: false,
      error: { code: 'not-positions-file' },
    });
  });

  it('keeps valid rows while reporting invalid and duplicate rows', () => {
    const parsed = readPositionsFile(
      JSON.stringify({
        app: 'edicius-hq',
        kind: 'investing-positions',
        version: 1,
        exportedAt: '2026-08-31T12:00:00.000Z',
        positions: [
          { symbol: 'AAPL', quantity: 1, averageCost: 100 },
          { symbol: 'aapl', quantity: 2, averageCost: 200 },
          { symbol: 7, quantity: 1, averageCost: 1 },
          { symbol: 'ZERO', quantity: 0, averageCost: 1 },
          { symbol: 'LOSS', quantity: 1, averageCost: -1 },
        ],
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        positions: [{ symbol: 'AAPL', quantity: 1, averageCost: 100 }],
        discarded: 4,
      },
    });
  });
});
