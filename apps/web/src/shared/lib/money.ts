/**
 * How every number that stands for money is written, across the whole app.
 *
 * There were three of these, one per feature, and they had drifted into three
 * different answers:
 *
 * ```
 * finance     Intl('en-US')          min 2, max 2, no symbol
 * greenlight  Intl('en-US')          max 2 and no minimum  ← dropped .00
 * investing   the browser's locale   min 2, max 2, sub-cent aware
 * ```
 *
 * So Greenlight wrote 1,365 where Finance wrote 1,365.00, and both wrote a
 * point where Investing wrote a comma — two decimal conventions in one app,
 * depending which tab you were on.
 *
 * The browser's locale wins. It is what the machine says the reader wants, it
 * is what Investing already did, and hardcoding `en-US` in a personal tool for
 * a reader whose system is not `en-US` is the accidental choice rather than the
 * deliberate one. Pass a locale explicitly to pin it — the tests do.
 */

/** Below this, two decimals would report a price of zero. */
const SUB_CENT = 0.01;

/** Enough to distinguish satoshi-scale prices without becoming a hash. */
const SUB_CENT_DIGITS = 8;

/** Shown where a number cannot be written: never a zero standing in for one. */
export const NO_VALUE = '—';

/**
 * An amount, with two decimals always — `.00` included.
 *
 * A column where one row reads 33.7 and the next 706.82 does not line up, and
 * the eye reads the shorter number as a different kind of quantity. On a list
 * of money that is exactly wrong.
 *
 * The exception is a value below a cent, where two decimals would report 0.00 —
 * not a rounder number but a false one. Crypto pairs are why that case exists.
 */
export function formatAmount(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return NO_VALUE;

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

/**
 * Symbols we compose ourselves. Anything else falls back to its code, which is
 * unambiguous and never wrong — a made-up glyph would be both.
 */
const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  PEN: 'S/',
};

/**
 * An amount with its currency symbol, in front, always.
 *
 * Deliberately *not* `Intl`'s `style: 'currency'`. That moves the symbol
 * according to the locale — measured, the same $17,615.03 becomes `17.615,03 $`
 * in `es-ES` and `USD 1,365.00` in `es-PE` — so unifying the number format
 * would also have silently relocated every currency figure in Greenlight. The
 * number convention was the thing that was broken; where the symbol sits was
 * not, and a fix should not redecorate what it passes.
 *
 * Finance goes without a symbol entirely, and is right to: an asset code there
 * can be a fiat currency, a crypto ticker or a stock — see `formatAssetAmount`.
 */
export function formatMoney(value: number, currency = 'USD', locale?: string): string {
  if (!Number.isFinite(value)) return NO_VALUE;

  const code = currency.toUpperCase();
  const symbol = SYMBOLS[code];
  const amount = formatAmount(value, locale);

  // A negative reads better with the sign outside: -$5.00, not $-5.00.
  if (!symbol) return `${code} ${amount}`;
  return value < 0 ? `-${symbol}${formatAmount(Math.abs(value), locale)}` : `${symbol}${amount}`;
}

/** The code and the amount, for a quantity whose unit is not a currency. */
export function formatAssetAmount(asset: string, value: number, locale?: string): string {
  return `${asset} ${formatAmount(value, locale)}`;
}

/**
 * A gain or a loss, signed.
 *
 * A loss carries its minus from the number itself, so an unsigned gain beside
 * it reads as neither — the eye has to find the colour before it knows which
 * way the row went. The plus is what makes the column symmetrical.
 */
export function formatSignedAmount(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  return (value > 0 ? '+' : '') + formatAmount(value, locale);
}

/** A signed percentage, on the same two-decimal rule. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NO_VALUE;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * A quantity, which is not money.
 *
 * Grouped and separated like everything else, so a holding written 1.25 never
 * sits beside a price written 1,25. But no minimum: three shares is `3`, not
 * `3.00`, because trailing zeros on a count claim a precision that is not there.
 */
export function formatQuantity(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  return value.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}
