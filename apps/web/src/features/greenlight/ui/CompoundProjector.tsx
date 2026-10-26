import { useMemo, useState } from 'react';

import { useProjectorCapital } from '@/features/greenlight/hooks/useProjectorCapital';
import {
  DEFAULT_ANNUAL_RATE,
  MONTHS_PER_YEAR,
  effectiveAnnualRate,
  firstYearInterest,
  formatRate,
  monthlyRate,
  projectMonths,
  yearsFrom,
} from '@/features/greenlight/lib/compound';
import { amountToInput, formatMoney, parseAmount } from '@/shared/lib/money';
import { Panel } from '@/shared/ui/Panel';

import styles from './CompoundProjector.module.css';

type CompoundProjectorProps = {
  /**
   * Greenlight's own net, read from the page rather than recomputed.
   *
   * Null where there is no document to read one from, and the field starts
   * empty — a projector that invented a capital would be the second net figure
   * on this page, and the reader would have no way to tell which of the two the
   * headline agreed with. The fee is charged per marker period and a period
   * under $1,000 gross is exempt, so a flat 10% of gross is $20,338.80 against
   * the real $20,377.80: close enough to pass a glance and $39 wrong.
   */
  capital: number | null;
  currency?: string;
};

/** A gain, with its sign in front of the symbol rather than after it. */
function signedMoney(value: number, currency: string): string {
  return value > 0 ? `+${formatMoney(value, currency)}` : formatMoney(value, currency);
}

/**
 * The net, to the cent, before it is written into a field.
 *
 * The net is a sum of floats and comes out of `computeSegmentedTotals` as
 * 20377.803000000004 — measured in the running app on 2026-08-22. Every place
 * that *formats* it hides that, `formatMoney` included, so the Stat above reads
 * $20,377.80 and nobody has ever seen the tail. An input is not a formatter: it
 * showed all fifteen digits, and a reader comparing the field to the headline
 * three inches above it would be looking at two different numbers for the net.
 * Rounded here rather than in `computeSegmentedTotals`, which is a Greenlight
 * figure this branch is not touching.
 */
function toCents(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? value : Math.round(value * 100) / 100;
}

/**
 * What the net becomes if it is left to compound.
 *
 * **The capital is stored; the rate is not.** The handoff left that open, and
 * the objection it left open with still stands in full: the Greenlight document
 * carries import modes and a marker migration, and a CSV import rewrites weeks
 * inside it, so a projector field has no business in that schema. What was
 * missing was the third option — the field gets a key of its own, next to
 * `finance-camera-views`, which is where this app already keeps the state that
 * says *how* a document is being looked at rather than what the document says.
 * See `useProjectorCapital` for who wins when the page's net and a stored
 * capital disagree, and the decision log for why the rate did not come along.
 */
export function CompoundProjector({ capital, currency = 'USD' }: CompoundProjectorProps) {
  /*
   * The page's net, ready to be written into a field, and the fallback rather
   * than the value: it is what the field shows while nobody has an opinion, and
   * `useProjectorCapital` decides when that is still true.
   */
  const netText = amountToInput(toCents(capital));
  const { capitalText, setCapitalText } = useProjectorCapital(netText);
  const [rateText, setRateText] = useState(amountToInput(DEFAULT_ANNUAL_RATE));

  const capitalValue = parseAmount(capitalText) ?? 0;
  const rateValue = parseAmount(rateText) ?? 0;

  const rows = useMemo(() => projectMonths(capitalValue, rateValue), [capitalValue, rateValue]);
  const firstYear = rows.slice(0, MONTHS_PER_YEAR);
  const years = useMemo(() => yearsFrom(rows), [rows]);

  return (
    <Panel aria-label="Compound projection">
      <div className={styles.heading}>
        <div className={styles.fields}>
          <label className={styles.field} htmlFor="compound-capital">
            <span className={styles.fieldLabel}>Capital</span>
            <input
              id="compound-capital"
              className={styles.input}
              inputMode="decimal"
              autoComplete="off"
              value={capitalText}
              onChange={(event) => setCapitalText(event.target.value)}
            />
          </label>
          <label className={styles.field} htmlFor="compound-rate">
            <span className={styles.fieldLabel}>Rate % a year</span>
            <input
              id="compound-rate"
              className={`${styles.input} ${styles.inputNarrow}`}
              inputMode="decimal"
              autoComplete="off"
              value={rateText}
              onChange={(event) => setRateText(event.target.value)}
            />
          </label>
          <p className={styles.derived}>
            <span>
              <strong>{formatRate(monthlyRate(rateValue) * 100, 3)}%</strong> a month
            </span>
            <span>
              <strong>{formatRate(effectiveAnnualRate(rateValue), 4)}%</strong> effective a year
            </span>
          </p>
        </div>
      </div>

      {rows.length ? (
        <div className={styles.columns}>
          <section
            className={`${styles.column} ${styles.firstYearColumn}`}
            aria-labelledby="first-year-title"
          >
            <h3 id="first-year-title" className={styles.columnTitle}>
              The first year
            </h3>
            <div className={styles.firstYearTables}>
              {[firstYear.slice(0, 6), firstYear.slice(6)].map((half, index) => (
                <table
                  key={index}
                  className={styles.table}
                  aria-label={index === 0 ? 'Months 1 to 6' : 'Months 7 to 12'}
                >
                  <thead>
                    <tr>
                      <th scope="col" className={styles.numeric}>
                        Month
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Interest
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Balance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {half.map((row) => (
                      <tr key={row.month}>
                        <td className={styles.numeric}>{row.month}</td>
                        <td className={styles.numeric}>{formatMoney(row.interest, currency)}</td>
                        <td className={styles.numeric}>{formatMoney(row.balance, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
            <p className={styles.yearInterest}>
              <span>Year 1 interest</span>
              <strong>{formatMoney(firstYearInterest(rows), currency)}</strong>
            </p>
          </section>

          <section className={styles.column} aria-labelledby="by-year-title">
            <h3 id="by-year-title" className={styles.columnTitle}>
              By year
            </h3>
            <div className={styles.byYearTables}>
              {[years.slice(0, 5), years.slice(5)].map((half, index) => (
                <table
                  key={index}
                  className={styles.table}
                  aria-label={index === 0 ? 'Years 1 to 5' : 'Years 6 to 10'}
                >
                  <thead>
                    <tr>
                      <th scope="col" className={styles.numeric}>
                        Year
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Balance
                      </th>
                      <th scope="col" className={styles.numeric}>
                        Earned
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {half.map((year) => (
                      <tr key={year.year}>
                        <td className={styles.numeric}>{year.year}</td>
                        <td className={styles.numeric}>{formatMoney(year.balance, currency)}</td>
                        <td className={`${styles.numeric} ${styles.gain}`}>
                          {signedMoney(year.gain, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <p className={styles.muted}>
          Type a capital above. Nothing compounds from zero, and a balance below it is a debt rather
          than a deposit.
        </p>
      )}
    </Panel>
  );
}
