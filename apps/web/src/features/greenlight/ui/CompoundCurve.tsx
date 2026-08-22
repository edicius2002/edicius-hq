import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { pointerInView } from '@/features/airfare/lib/crosshair';
import { MONTHS_PER_YEAR, type ProjectedMonth } from '@/features/greenlight/lib/compound';
import {
  CURVE_VIEW,
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  curveLayout,
  monthAtView,
} from '@/features/greenlight/lib/compoundCurve';
import { formatMoney } from '@/shared/lib/money';

import styles from './CompoundCurve.module.css';

/** Where the crosshair sits before anybody has touched it — halfway, month 60. */
const RESTING_MONTH = 60;

type CompoundCurveProps = {
  rows: ProjectedMonth[];
  capital: number;
  currency: string;
};

/** A gain, with its sign in front of the symbol rather than after it. */
function signedMoney(value: number, currency: string): string {
  return value > 0 ? `+${formatMoney(value, currency)}` : formatMoney(value, currency);
}

/**
 * The balance over ten years, with a crosshair that reads a month off it.
 *
 * The crosshair does not go away when the pointer does. Airfare's does, and is
 * right to: there the hairline is one of two prices being compared and a
 * hairline nobody placed would be asserting a comparison nobody asked for.
 * Here the readout is the only place the middle column says a number at all, so
 * an empty chart at rest would be a third of this section printing nothing
 * until it is hovered — and nothing at all for a reader who never hovers.
 */
export function CompoundCurve({ rows, capital, currency }: CompoundCurveProps) {
  const [month, setMonth] = useState(RESTING_MONTH);
  const layout = useMemo(() => curveLayout(rows, capital), [rows, capital]);

  if (!rows.length) {
    return <p className={styles.empty}>Nothing to project yet.</p>;
  }

  const current = rows[Math.min(month, rows.length) - 1];
  const hairX = layout.xAt(current.month);
  const hairY = layout.yAt(current.balance);

  /**
   * Where the pointer is, in the units the drawing is drawn in.
   *
   * `pointerInView` is `airfare/lib/crosshair.ts`'s and is imported rather than
   * copied — the first import this repository has between two feature slices,
   * and a deliberate one. It is pure geometry with nothing about fares in it,
   * it was written to close a measured bug on 2026-08-22, and the shape of that
   * bug is that a second copy looks right for years and is wrong at the edges:
   * `((clientX - box.left) / box.width) * CURVE_VIEW.width` reads the middle of
   * the plot exactly and drifts further the closer the hand gets to either end,
   * which is why nobody found it the first time. Two copies of an arithmetic
   * nobody can eyeball is how it comes back. It belongs in `shared/lib`, and
   * moving it means editing the airfare slice, which this branch is not allowed
   * to do — left open in the handoff.
   *
   * This chart's box does not share the viewBox's shape at any width: the
   * drawing is 640x360 and the stylesheet gives the element a full-width box of
   * fixed height, so it letterboxes in a narrow column and pillarboxes in a
   * wide one. Measured in Chrome on 2026-08-22 at the owner's 1536-px window,
   * the column is **418.79 x 240** and the drawing letterboxes by 2.2 units a
   * side — so there is no horizontal bar today and the old formula would agree
   * exactly, which is the airfare slice's chart A all over again. **The
   * boundary is 29 px away.** Pillarboxing starts the moment the box passes
   * 426.67 wide, which on this page is a viewport of about 1565. Driven to a
   * 700-px box in the live page: 136.67 units of pillarbox a side, and a
   * pointer placed exactly on month 120 read month 120 here and **month 92**
   * through the old formula.
   */
  function trackPointer(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const at = pointerInView(box, CURVE_VIEW, event.clientX, event.clientY);
    if (!at) return;
    setMonth(monthAtView(at.x, rows.length, layout.step));
  }

  /** The same walk without a pointer, because a hover-only readout is unreachable. */
  function walk(event: KeyboardEvent<SVGSVGElement>) {
    const deltas: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      PageDown: -MONTHS_PER_YEAR,
      PageUp: MONTHS_PER_YEAR,
    };
    const isEnd = event.key === 'Home' || event.key === 'End';
    if (deltas[event.key] === undefined && !isEnd) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 1
        : event.key === 'End'
          ? rows.length
          : current.month + deltas[event.key];
    setMonth(Math.min(Math.max(next, 1), rows.length));
  }

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${CURVE_VIEW.width} ${CURVE_VIEW.height}`}
        className={styles.svg}
        role="img"
        aria-label={`Balance over ${rows.length} months, from ${formatMoney(capital, currency)} to ${formatMoney(layout.top, currency)}`}
        tabIndex={0}
        onPointerMove={trackPointer}
        onKeyDown={walk}
      >
        {layout.ticks.map((tick) => (
          <g key={tick.value}>
            <line className={styles.grid} x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={tick.y} y2={tick.y} />
            <text className={styles.axis} x={PLOT_LEFT - 8} y={tick.y + 4} textAnchor="end">
              {formatMoney(tick.value, currency)}
            </text>
          </g>
        ))}

        <path className={styles.curve} d={layout.path} />

        <line className={styles.hair} x1={hairX} x2={hairX} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
        <circle className={styles.mark} cx={hairX} cy={hairY} r={4} />
        <text className={styles.hairLabel} x={hairX} y={PLOT_BOTTOM + 16} textAnchor="middle">
          {current.month}
        </text>

        <text className={styles.axis} x={PLOT_LEFT} y={PLOT_BOTTOM + 34} textAnchor="start">
          Month 1
        </text>
        <text className={styles.axis} x={PLOT_RIGHT} y={PLOT_BOTTOM + 34} textAnchor="end">
          Month {rows.length}
        </text>
      </svg>

      <p className={styles.readout} role="status">
        <span className={styles.readoutMonth}>Month {current.month}</span>
        <strong className={styles.readoutBalance}>{formatMoney(current.balance, currency)}</strong>
        <span className={styles.readoutGain}>{signedMoney(current.gain, currency)} earned</span>
      </p>
    </div>
  );
}
