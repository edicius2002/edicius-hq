/**
 * How a price is written on this page.
 *
 * Always two decimals, `.00` included. A column where one row reads 33,7 and
 * the next 706,82 does not line up, and the eye reads the shorter number as a
 * different kind of quantity — which on a list of prices is exactly wrong.
 *
 * The exception is an asset priced below a cent. Two decimals would round it to
 * 0,00, which is not a rounder price but a wrong one, so it keeps enough digits
 * to say something. Crypto pairs are the reason this case exists at all.
 */

/** Below this, two decimals would report a price of zero. */
const SUB_CENT = 0.01;

/** Enough to distinguish satoshi-scale prices without becoming a hash. */
const SUB_CENT_DIGITS = 8;

export function formatPrice(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '—';

  if (value !== 0 && Math.abs(value) < SUB_CENT) {
    return value.toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: SUB_CENT_DIGITS,
    });
  }

  return value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The signed percentage beside it, on the same two-decimal rule. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * A gain or a loss, signed.
 *
 * A loss carries its minus from the number itself, so an unsigned gain beside
 * it reads as neither — the eye has to find the colour before it knows which
 * way the row went. The plus is what makes the column symmetrical.
 */
export function formatSignedPrice(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '—';
  return (value > 0 ? '+' : '') + formatPrice(value, locale);
}

/**
 * A quantity, which is not money.
 *
 * Grouped and decimal-separated like everything else on the page — a holding
 * written 1.25 beside a price written 1,25 makes the reader parse two
 * conventions in one row. But no minimum: three shares is `3`, not `3,00`,
 * because trailing zeros on a count claim a precision that is not there.
 */
export function formatQuantity(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}
