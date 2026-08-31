import {
  isUsableCost,
  isUsableQuantity,
  normalizePortfolio,
  setPosition,
  type Portfolio,
  type Position,
} from '@/features/investing/data/portfolio';
import { err, ok, type Result } from '@/features/finance/lib/result';

export const POSITIONS_FILE_APP = 'edicius-hq';
export const POSITIONS_FILE_KIND = 'investing-positions';
export const POSITIONS_FILE_VERSION = 1;

/** Positions stay separate from the watchlist, whose names are learned locally. */
export type PositionsFile = {
  app: string;
  kind: string;
  version: number;
  exportedAt: string;
  positions: Position[];
};

export function createPositionsFile(portfolio: Portfolio, exportedAt: string): PositionsFile {
  return {
    app: POSITIONS_FILE_APP,
    kind: POSITIONS_FILE_KIND,
    version: POSITIONS_FILE_VERSION,
    exportedAt,
    positions: portfolio.positions,
  };
}

/** `positions-2026-08-31.json` sorts with the date without pretending a bad clock is valid. */
export function positionsFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10);
  return `positions-${/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown'}.json`;
}

export type PositionsFileError = { code: 'unreadable' } | { code: 'not-positions-file' };

export function describePositionsFileError(error: PositionsFileError): string {
  return error.code === 'unreadable'
    ? 'That file is not JSON, so there was nothing to import.'
    : 'That file is not a positions export. Nothing was changed.';
}

export type ImportedPositions = {
  positions: Position[];
  discarded: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositionsArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Establish the file's intent before normalizing it. Storage may repair a
 * damaged portfolio, but accepting a random JSON object as an empty import
 * would make a successful message mean nothing.
 */
function pickPositions(parsed: unknown): unknown[] | null {
  if (!isRecord(parsed)) return null;

  if (
    parsed.app === POSITIONS_FILE_APP &&
    parsed.kind === POSITIONS_FILE_KIND &&
    parsed.version === POSITIONS_FILE_VERSION &&
    typeof parsed.exportedAt === 'string' &&
    isPositionsArray(parsed.positions)
  ) {
    return parsed.positions;
  }

  // A naked portfolio is what local storage contains, so it is useful without
  // teaching the importer a second, looser document format.
  if (parsed.version === 1 && isPositionsArray(parsed.positions)) return parsed.positions;

  return null;
}

function isUsablePosition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.symbol === 'string' &&
    value.symbol.trim() !== '' &&
    isUsableQuantity(value.quantity) &&
    isUsableCost(value.averageCost)
  );
}

/**
 * Reads only a known positions shape, then uses the storage normalizer for the
 * same symbol and duplicate rules the portfolio has everywhere else.
 */
export function readPositionsFile(text: string): Result<ImportedPositions, PositionsFileError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err({ code: 'unreadable' });
  }

  const source = pickPositions(parsed);
  if (!source) return err({ code: 'not-positions-file' });

  const usable = source.filter(isUsablePosition);
  const portfolio = normalizePortfolio({ version: 1, positions: usable });
  return ok({
    positions: portfolio.positions,
    discarded: source.length - portfolio.positions.length,
  });
}

export type PositionsMerge = {
  portfolio: Portfolio;
  added: number;
  updated: number;
};

/** Existing rows stay in place, so import behaves like correcting several rows at once. */
export function mergeImportedPositions(portfolio: Portfolio, imported: Position[]): PositionsMerge {
  const clean = normalizePortfolio({ version: 1, positions: imported }).positions;
  let next = portfolio;
  let added = 0;
  let updated = 0;

  for (const position of clean) {
    if (next.positions.some((current) => current.symbol === position.symbol)) updated += 1;
    else added += 1;
    next = setPosition(next, position.symbol, position.quantity, position.averageCost);
  }

  return { portfolio: next, added, updated };
}
