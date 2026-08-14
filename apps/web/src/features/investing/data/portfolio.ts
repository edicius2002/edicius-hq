import type { Quote } from '@/shared/api/market';

/**
 * What you own, and what it is worth today.
 *
 * A position is a quantity you state and a cost you paid; its value is the
 * market's business. Decision 8.5 keeps that distinct from a Finance holding,
 * which is an amount you state outright — they look alike and behave nothing
 * alike, so they never share a type or a store.
 *
 * `averageCost` is a price per unit, not a total. That is what the legacy
 * stored and what was migrated, and multiplying it by the quantity is the only
 * place a cost total is ever formed.
 */

export const PORTFOLIO_KEY = 'portfolio';

export type Position = {
  symbol: string;
  /** Fractional on purpose: 0.7 of a QQQ is a real position. */
  quantity: number;
  /** Average price paid per unit. */
  averageCost: number;
};

export type Portfolio = {
  version: 1;
  positions: Position[];
};

export const EMPTY_PORTFOLIO: Portfolio = { version: 1, positions: [] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A quantity of zero is not a position, it is the absence of one — storing it
 * would leave a row that says nothing and computes nothing.
 */
export function isUsableQuantity(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** A cost of zero is legitimate: something granted or airdropped cost nothing. */
export function isUsableCost(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function normalizePortfolio(value: unknown): Portfolio {
  if (!value || typeof value !== 'object') return EMPTY_PORTFOLIO;

  const raw = (value as { positions?: unknown }).positions;
  if (!Array.isArray(raw)) return EMPTY_PORTFOLIO;

  const seen = new Set<string>();
  const positions: Position[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { symbol, quantity, averageCost } = entry as Record<string, unknown>;

    if (typeof symbol !== 'string') continue;
    const key = symbol.trim().toUpperCase();
    // A duplicate would make the total depend on which row was read last.
    if (!key || seen.has(key)) continue;
    if (!isUsableQuantity(quantity) || !isUsableCost(averageCost)) continue;

    seen.add(key);
    positions.push({ symbol: key, quantity, averageCost });
  }

  return { version: 1, positions };
}

export function positionFor(portfolio: Portfolio, symbol: string): Position | undefined {
  const key = symbol.trim().toUpperCase();
  return portfolio.positions.find((position) => position.symbol === key);
}

/**
 * Adds or replaces a position, keeping the list in the order it was built.
 *
 * Editing in place rather than removing and appending: a row that jumped to the
 * bottom every time you corrected a cost would be its own small annoyance.
 */
export function setPosition(
  portfolio: Portfolio,
  symbol: string,
  quantity: number,
  averageCost: number,
): Portfolio {
  const key = symbol.trim().toUpperCase();
  if (!key || !isUsableQuantity(quantity) || !isUsableCost(averageCost)) return portfolio;

  const next: Position = { symbol: key, quantity, averageCost };
  const index = portfolio.positions.findIndex((position) => position.symbol === key);

  const positions =
    index === -1
      ? [...portfolio.positions, next]
      : portfolio.positions.map((position, at) => (at === index ? next : position));

  return { version: 1, positions };
}

export function removePosition(portfolio: Portfolio, symbol: string): Portfolio {
  const key = symbol.trim().toUpperCase();
  const positions = portfolio.positions.filter((position) => position.symbol !== key);
  // Identity when nothing was there, so the storage facade skips the write.
  return positions.length === portfolio.positions.length ? portfolio : { version: 1, positions };
}

/** Move one position to where another sits, preserving the stored order. */
export function reorderPositions(portfolio: Portfolio, from: string, to: string): Portfolio {
  const source = from.trim().toUpperCase();
  const target = to.trim().toUpperCase();
  if (source === target) return portfolio;

  const fromIndex = portfolio.positions.findIndex((position) => position.symbol === source);
  const toIndex = portfolio.positions.findIndex((position) => position.symbol === target);
  if (fromIndex < 0 || toIndex < 0) return portfolio;

  const positions = [...portfolio.positions];
  const [moved] = positions.splice(fromIndex, 1);
  positions.splice(toIndex, 0, moved);
  return { version: 1, positions };
}

export type Valuation = {
  position: Position;
  currency: string;
  price: number;
  cost: number;
  value: number;
  profit: number;
  /** Null when the cost was nothing: a return on zero has no percentage. */
  profitPercent: number | null;
};

/**
 * What a position is worth, or nothing at all.
 *
 * Returns null when no quote has arrived rather than valuing it at zero. A
 * portfolio that quietly reported a total missing one of its holdings would be
 * worse than one that says a row is still loading.
 */
export function valuePosition(position: Position, quote: Quote | undefined): Valuation | null {
  if (!quote || !Number.isFinite(quote.price)) return null;

  const cost = position.averageCost * position.quantity;
  const value = quote.price * position.quantity;
  const profit = value - cost;

  return {
    position,
    currency: quote.currency,
    price: quote.price,
    cost,
    value,
    profit,
    profitPercent: cost > 0 ? (profit / cost) * 100 : null,
  };
}

export type Total = {
  currency: string;
  cost: number;
  value: number;
  profit: number;
  profitPercent: number | null;
  positions: number;
};

/**
 * Totals, one per currency.
 *
 * Equities quote in USD and pairs in USDT. Adding them would be a conversion
 * the code performs without saying so, at a rate nobody chose — so they are
 * summed apart, and a second line only exists when there is something in it.
 */
export function totalsByCurrency(valuations: Valuation[]): Total[] {
  const byCurrency = new Map<string, Total>();

  for (const valuation of valuations) {
    const current = byCurrency.get(valuation.currency) ?? {
      currency: valuation.currency,
      cost: 0,
      value: 0,
      profit: 0,
      profitPercent: null,
      positions: 0,
    };

    current.cost += valuation.cost;
    current.value += valuation.value;
    current.profit += valuation.profit;
    current.positions += 1;
    byCurrency.set(valuation.currency, current);
  }

  return (
    [...byCurrency.values()]
      .map((total) => ({
        ...total,
        profitPercent: total.cost > 0 ? (total.profit / total.cost) * 100 : null,
      }))
      // Largest first: with more than one, the one that matters is the one you
      // hold most of, not whichever symbol happened to be added first.
      .sort((a, b) => b.value - a.value)
  );
}

export function symbolsOf(portfolio: Portfolio): string[] {
  return portfolio.positions.map((position) => position.symbol);
}
