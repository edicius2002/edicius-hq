/** Finance stores amounts as numbers, but all arithmetic crosses a cent boundary. */
export function toCents(value: number): number {
  const [coefficient, exponent = '0'] = Math.abs(value).toString().split('e');
  return Math.sign(value) * Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function moneyAmount(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : fromCents(toCents(value));
}

export function addMoney(left: number, right: number): number {
  return fromCents(toCents(left) + toCents(right));
}

export function subtractMoney(left: number, right: number): number {
  return fromCents(toCents(left) - toCents(right));
}
