import { describe, expect, it } from 'vitest';

import {
  amountToInput,
  formatAmount,
  formatAssetAmount,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedAmount,
  parseAmount,
  roundAmount,
} from '@/shared/lib/money';

describe('formatAmount', () => {
  it('always writes two decimals, including the zeros', () => {
    // A column where one row reads 33.7 and the next 706.82 does not line up,
    // and the shorter number reads as a different kind of quantity.
    expect(formatAmount(33.7, 'en-US')).toBe('33.70');
    expect(formatAmount(706.4, 'en-US')).toBe('706.40');
    expect(formatAmount(26, 'en-US')).toBe('26.00');
  });

  it('does not round a sub-cent price down to nothing', () => {
    // 0.00 is not a rounder price, it is a wrong one — and this is why crypto
    // pairs exist in the same list as equities.
    expect(formatAmount(0.00001234, 'en-US')).toBe('0.00001234');
    expect(formatAmount(0.004, 'en-US')).toBe('0.004');
  });

  it('keeps two decimals at the boundary and below the sub-cent rule', () => {
    expect(formatAmount(0.01, 'en-US')).toBe('0.01');
    expect(formatAmount(0, 'en-US')).toBe('0.00');
  });

  it('groups thousands the way the locale does', () => {
    expect(formatAmount(64250.99, 'en-US')).toBe('64,250.99');
  });

  it('says nothing rather than NaN', () => {
    expect(formatAmount(Number.NaN)).toBe('—');
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('signs the rise and writes two decimals', () => {
    expect(formatPercent(1.5)).toBe('+1.50%');
    expect(formatPercent(-0.1)).toBe('-0.10%');
    expect(formatPercent(0)).toBe('+0.00%');
  });

  it('says nothing when there is no previous close to measure against', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatSignedAmount', () => {
  it('signs a gain, because the loss beside it is already signed', () => {
    // Unsigned, a gain reads as neither and the eye has to find the colour
    // before it knows which way the row went.
    expect(formatSignedAmount(15.09, 'en-US')).toBe('+15.09');
    expect(formatSignedAmount(-17.22, 'en-US')).toBe('-17.22');
    expect(formatSignedAmount(0, 'en-US')).toBe('0.00');
  });
});

describe('formatQuantity', () => {
  it('keeps a whole count whole', () => {
    // Three shares is 3, not 3.00: trailing zeros on a count claim a precision
    // that is not there.
    expect(formatQuantity(3, 'en-US')).toBe('3');
  });

  it('writes a fraction the same way the prices are written', () => {
    expect(formatQuantity(0.7, 'en-US')).toBe('0.7');
    expect(formatQuantity(1.25, 'en-US')).toBe('1.25');
  });

  it('does not round a small crypto holding to nothing', () => {
    expect(formatQuantity(0.00012345, 'en-US')).toBe('0.00012345');
  });
});

describe('formatMoney', () => {
  it('keeps the zeros a currency needs', () => {
    // Greenlight wrote "$1,365" here for months: `maximumFractionDigits: 2`
    // with no minimum drops the decimals whenever they are zero, and on a
    // column of money that reads as a different kind of number.
    expect(formatMoney(1365, 'USD', 'en-US')).toBe('$1,365.00');
    expect(formatMoney(1365.5, 'USD', 'en-US')).toBe('$1,365.50');
  });

  it('honours the currency it is given', () => {
    expect(formatMoney(10, 'EUR', 'en-US')).toBe('€10.00');
  });

  it('keeps the symbol in front whatever the locale does', () => {
    /*
     * Measured before choosing this: Intl's own `style: 'currency'` renders
     * $17,615.03 as `17.615,03 $` in es-ES and `USD 1,365.00` in es-PE. Fixing
     * the decimal convention would then have silently relocated every figure in
     * Greenlight, which was not the thing that was broken.
     */
    expect(formatMoney(17615.03, 'USD', 'es-ES')).toBe('$17.615,03');
    expect(formatMoney(17615.03, 'USD', 'en-US')).toBe('$17,615.03');
  });

  it('puts the minus outside the symbol', () => {
    expect(formatMoney(-5, 'USD', 'en-US')).toBe('-$5.00');
  });

  it('falls back to the code rather than inventing a glyph', () => {
    expect(formatMoney(3, 'JPY', 'en-US')).toBe('JPY 3.00');
  });

  it('says nothing rather than NaN', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
  });
});

describe('formatAssetAmount', () => {
  it('puts the code before the number, with no currency symbol', () => {
    // An asset code here can be a fiat currency, a crypto ticker or a stock,
    // and only the code beside it says which — so no symbol is invented.
    expect(formatAssetAmount('PEN', 2003.13, 'en-US')).toBe('PEN 2,003.13');
    expect(formatAssetAmount('BTC', 0.5, 'en-US')).toBe('BTC 0.50');
  });
});

describe('one rule for the whole app', () => {
  it('writes the same number the same way whichever feature asks', () => {
    // Three formatters had drifted to three answers. This is the guard.
    const amount = 1365;

    expect(formatAmount(amount, 'en-US')).toBe('1,365.00');
    expect(formatMoney(amount, 'USD', 'en-US')).toBe('$1,365.00');
    expect(formatAssetAmount('USD', amount, 'en-US')).toBe('USD 1,365.00');
    expect(formatSignedAmount(amount, 'en-US')).toBe('+1,365.00');
  });

  it('follows the reader locale rather than a hardcoded one', () => {
    // The bug this replaces: Finance and Greenlight said en-US while Investing
    // asked the browser, so the same app used two decimal conventions.
    expect(formatAmount(1234.5, 'de-DE')).toBe('1.234,50');
    expect(formatAmount(1234.5, 'en-US')).toBe('1,234.50');
  });
});

describe('parseAmount', () => {
  it('reads the comma as the decimal separator', () => {
    expect(parseAmount('12,34')).toBe(12.34);
    expect(parseAmount('0,5')).toBe(0.5);
    expect(parseAmount('-7,25')).toBe(-7.25);
  });

  it('still reads a point, because the field converts one as you type', () => {
    expect(parseAmount('12.34')).toBe(12.34);
  });

  it('treats a second separator as a typo, not as a thousands mark', () => {
    // Parsing `1.234,56` as 1234.56 would mean parsing a mistyped `1.5` as 15.
    // Nothing writes grouping into an input, so the safe reading is "unfinished".
    expect(parseAmount('1.234,56')).toBeNull();
    expect(parseAmount('1,2,3')).toBeNull();
  });

  it('says nothing rather than zero for what has not been typed yet', () => {
    // A balance nobody has filled in is not a balance of nothing.
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount(',')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('keeps zero, which is a real amount', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('0,00')).toBe(0);
  });
});

describe('amountToInput', () => {
  it('writes the comma the rest of the app writes', () => {
    expect(amountToInput(12.34)).toBe('12,34');
    expect(amountToInput(-7.25)).toBe('-7,25');
  });

  it('groups nothing, so what it writes can be read back unchanged', () => {
    const written = amountToInput(1234567.89);
    expect(written).toBe('1234567,89');
    expect(parseAmount(written)).toBe(1234567.89);
  });

  it('round-trips every amount it writes', () => {
    for (const value of [0, 0.01, 1, 999999.99, -450.5, 1733.33]) {
      expect(parseAmount(amountToInput(value))).toBe(value);
    }
  });

  it('shows an empty field for no amount, not a zero', () => {
    expect(amountToInput(null)).toBe('');
    expect(amountToInput(Number.NaN)).toBe('');
  });
});

describe('roundAmount', () => {
  it('drops the noise floating point leaves on a fee chain', () => {
    expect(roundAmount(7.039999999999964)).toBe(7.04);
    expect(roundAmount(8 * 0.88)).toBe(7.04);
  });

  it('keeps what is below a cent, where two decimals would report zero', () => {
    expect(roundAmount(0.00000123)).toBe(0.00000123);
    expect(roundAmount(0.005)).toBe(0.005);
  });

  it('leaves an amount that is already exact alone', () => {
    for (const value of [0, 1, -450.5, 999999.99]) {
      expect(roundAmount(value)).toBe(value);
    }
  });

  it('passes a non-number through rather than inventing one', () => {
    expect(roundAmount(Number.NaN)).toBeNaN();
  });
});

describe('amountToInput after rounding', () => {
  it('writes the amount a person would read, not every binary digit of it', () => {
    expect(amountToInput(7.039999999999964)).toBe('7,04');
  });
});
