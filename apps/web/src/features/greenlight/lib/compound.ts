/**
 * What a balance does when the interest it earns is left where it landed.
 *
 * Every number the projector prints comes from here, so the whole of it can be
 * checked without a browser — which is the point, because the one thing this
 * feature can get wrong in a way nobody notices is the arithmetic. A curve that
 * is drawn ten pixels off is visibly ten pixels off; a rate compounded on the
 * wrong convention is a plausible number that is simply not the right one.
 */

/** Interest is paid once a month, so a year is twelve payments. */
export const MONTHS_PER_YEAR = 12;

/** The projection runs ten years, because that is the horizon the table ends on. */
export const PROJECTION_YEARS = 10;

export const PROJECTION_MONTHS = PROJECTION_YEARS * MONTHS_PER_YEAR;

/**
 * The years the right-hand table names. Not every year: 1, 2 and 3 are where
 * the reader can still feel the difference between one row and the next, and 5
 * and 10 are the two the question is usually really about. Twelve rows of
 * near-identical growth is a table nobody reads to the bottom of.
 */
export const YEAR_MARKS = [1, 2, 3, 5, 10];

/** The rate the field starts on, as a percentage. Editable, never stored. */
export const DEFAULT_ANNUAL_RATE = 6;

/**
 * The monthly rate, as a fraction — **the nominal convention, `annual / 12`**.
 *
 * 6% a year paid monthly is 0.5% a month and not `(1.06)^(1/12) - 1 = 0.4868%`.
 * The two are different questions wearing the same words: the second asks what
 * monthly rate compounds *to* 6% a year, which is the right answer to a
 * question nobody asked here. What is being modelled is an instrument that
 * quotes 6% annual and pays a twelfth of it every month, so the year comes out
 * above 6% — see `effectiveAnnualRate` — and that surplus is the entire subject
 * of the section.
 *
 * The difference is not academic at this scale, and it is larger than it was
 * thought to be. On $20,377.80 over ten years the nominal convention reaches
 * **$37,075.30** and the equivalent-yield one **$36,493.54** — $581.77 apart,
 * measured, where the brief for this section expected about $70. The only
 * reading that lands near $70 is continuous compounding, at $37,130.77, which
 * is $55.47 *above* the nominal answer rather than below it.
 */
export function monthlyRate(annualPercent: number): number {
  if (!Number.isFinite(annualPercent)) return 0;
  return annualPercent / 100 / MONTHS_PER_YEAR;
}

/**
 * What a year of monthly payments actually yields, as a percentage.
 *
 * Shown on the page because without it the first year reads as an arithmetic
 * error. A reader who is told "6%" and then handed $1,256.86 on $20,377.80 can
 * see for themselves that 6% of the capital is $1,222.67, and the $34.19
 * between them is the whole of what reinvesting bought — but only if the page
 * says 6.1678% somewhere. Otherwise it looks like the page cannot multiply.
 */
export function effectiveAnnualRate(annualPercent: number): number {
  return ((1 + monthlyRate(annualPercent)) ** MONTHS_PER_YEAR - 1) * 100;
}

/** One month of the projection: what it earned, and where that left the balance. */
export type ProjectedMonth = {
  /** 1-based, because the table's first row is month 1 and not month 0. */
  month: number;
  /** Earned during this month, on the balance the month opened with. */
  interest: number;
  /** After this month's interest was added back. */
  balance: number;
  /** Everything earned since the start — `balance - capital`. */
  gain: number;
};

/**
 * The whole projection, month by month.
 *
 * **Nothing is rounded on the way through.** Each month earns on the balance
 * the month before it closed at, in full precision, and cents appear only where
 * a figure is formatted for the screen. Rounding to the cent at every step and
 * compounding the rounded figure is the other defensible reading — it is what a
 * bank statement would show — and measured on $20,377.80 at 6% it drifts: month
 * 12 closes at $21,634.67 against $21,634.66, and month 120 at $37,075.34
 * against $37,075.30. Four cents over ten years is not a large error, and it is
 * an error that would have to be explained every time somebody checked the
 * table against a calculator.
 *
 * A capital of zero or less yields no rows at all. A negative balance
 * compounding is arithmetic that is perfectly happy to run and describes
 * nothing anybody is asking about — a debt at 6% is a different instrument with
 * a different sign convention — so the projector shows nothing rather than a
 * confident spiral downwards.
 */
export function projectMonths(
  capital: number,
  annualPercent: number,
  months = PROJECTION_MONTHS,
): ProjectedMonth[] {
  if (!Number.isFinite(capital) || capital <= 0) return [];

  const rate = monthlyRate(annualPercent);
  const rows: ProjectedMonth[] = [];
  let balance = capital;

  for (let month = 1; month <= months; month += 1) {
    const interest = balance * rate;
    balance += interest;
    rows.push({ month, interest, balance, gain: balance - capital });
  }

  return rows;
}

/** A year the right-hand table names, read off the month it ends on. */
export type ProjectedYear = { year: number; balance: number; gain: number };

/**
 * The named years, read from the months already projected.
 *
 * Read rather than recomputed, so the year-1 row and the twelfth row of the
 * left-hand table cannot disagree — two figures for the same month is exactly
 * the class of bug this section is otherwise well placed to introduce. A year
 * the projection does not reach is dropped instead of extrapolated.
 */
export function yearsFrom(rows: ProjectedMonth[], marks: number[] = YEAR_MARKS): ProjectedYear[] {
  const years: ProjectedYear[] = [];
  for (const year of marks) {
    const row = rows[year * MONTHS_PER_YEAR - 1];
    if (!row) continue;
    years.push({ year, balance: row.balance, gain: row.gain });
  }
  return years;
}

/** What the first twelve months earned between them — the left table's footer. */
export function firstYearInterest(rows: ProjectedMonth[]): number {
  return rows.slice(0, MONTHS_PER_YEAR).reduce((sum, row) => sum + row.interest, 0);
}

/**
 * A rate, written the way this app writes every other number.
 *
 * Deliberately not `toFixed`. The reader's locale decides whether a decimal is
 * a point or a comma — that is what `shared/lib/money` settled for money, and a
 * page reading `$20.377,80` beside `0.500 %` would be carrying both conventions
 * a foot apart. The digit count is fixed by the caller because the two rates on
 * screen want different precision: three decimals is what makes 0.500 read as a
 * monthly rate rather than a half of something, and the effective annual figure
 * is only worth showing to the fourth, where 6.1678 stops being 6.17.
 */
export function formatRate(value: number, digits: number, locale?: string): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
