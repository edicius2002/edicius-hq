const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
];

/**
 * Turns an absolute moment into the part a reader needs first; the caller can
 * keep the exact date in a title without spending the page's scarce attention
 * on it all the time.
 */
export function formatRelativeTime(value: string | Date, now = new Date()): string | null {
  const elapsed = new Date(value).getTime() - now.getTime();
  if (!Number.isFinite(elapsed)) return null;

  const [unit, milliseconds] = UNITS.find(([, size]) => Math.abs(elapsed) >= size) ?? UNITS.at(-1)!;
  const amount = Math.trunc(elapsed / milliseconds);

  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit);
}
