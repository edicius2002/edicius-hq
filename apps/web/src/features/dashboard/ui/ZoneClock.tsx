import { useEffect, useMemo, useState } from 'react';

import styles from './ZoneClock.module.css';

type ZoneClockProps = {
  label: string;
  timeZone: string;
};

export function ZoneClock({ label, timeZone }: ZoneClockProps) {
  const [now, setNow] = useState(() => new Date());
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    [timeZone],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const parts = formatter.formatToParts(now);
  const hours = parts.find((part) => part.type === 'hour')?.value;
  const minutes = parts.find((part) => part.type === 'minute')?.value;

  return (
    <time
      className={styles.clock}
      dateTime={now.toISOString()}
      aria-label={`${label} ${hours}:${minutes}`}
    >
      <span className={styles.digits} aria-hidden="true">
        {hours}
        <span className={styles.colon}>:</span>
        {minutes}
      </span>
      <span className={styles.label} aria-hidden="true">
        {label}
      </span>
    </time>
  );
}
