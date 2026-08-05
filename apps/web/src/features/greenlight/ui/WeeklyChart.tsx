import type { WeekPoint } from '@/features/greenlight/model/types';
import { formatMoney } from '@/features/greenlight/lib/format';

import styles from './WeeklyChart.module.css';

type WeeklyChartProps = {
  points: WeekPoint[];
};

export function WeeklyChart({ points }: WeeklyChartProps) {
  if (!points.length) {
    return <p className={styles.empty}>No weekly data yet. Import a CSV to begin.</p>;
  }

  const width = 560;
  const height = 180;
  const pad = { top: 16, right: 16, bottom: 36, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxValue = Math.max(...points.map((point) => point.amount), 1);
  const step = maxValue > 4000 ? 1000 : 500;
  const top = Math.max(step * 2, Math.ceil(maxValue / step) * step);

  const xAt = (index: number) =>
    pad.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const yAt = (value: number) => pad.top + plotH - (value / top) * plotH;

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xAt(index)} ${yAt(point.amount)}`)
    .join(' ');

  const area = `${path} L ${xAt(points.length - 1)} ${pad.top + plotH} L ${xAt(0)} ${pad.top + plotH} Z`;

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={styles.svg}
        role="img"
        aria-label="Weekly amounts"
      >
        {[0, 0.5, 1].map((fraction) => {
          const value = top * fraction;
          const y = yAt(value);
          return (
            <g key={value}>
              <line className={styles.grid} x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
              <text className={styles.axis} x={pad.left - 8} y={y + 4} textAnchor="end">
                {value >= 1000 ? `$${value / 1000}k` : `$${value}`}
              </text>
            </g>
          );
        })}
        <path className={styles.area} d={area} />
        <path className={styles.line} d={path} />
        {points.map((point, index) => (
          <circle
            key={point.key}
            className={styles.dot}
            cx={xAt(index)}
            cy={yAt(point.amount)}
            r={3.5}
          >
            <title>
              {point.label}: {formatMoney(point.amount, point.currency)}
            </title>
          </circle>
        ))}
        {points.map((point, index) => (
          <text
            key={`${point.key}-label`}
            className={styles.axis}
            x={xAt(index)}
            y={height - 12}
            textAnchor="middle"
          >
            {point.label.split('–')[0]}
          </text>
        ))}
      </svg>
    </div>
  );
}
