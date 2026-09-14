import type { CodexReset } from '@/shared/api/codexResets';

const BOGOTA_TIME_ZONE = 'America/Bogota';
const DAY_MS = 86_400_000;
const WEEKS = 53;

const civilDate = new Intl.DateTimeFormat('en-US', {
  timeZone: BOGOTA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const exactDate = new Intl.DateTimeFormat('en-US', {
  timeZone: BOGOTA_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

export function bogotaDateKey(value: string | Date): string {
  const parts = civilDate.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatBogotaDateTime(value: string | Date): string {
  return `${exactDate.format(new Date(value))} GMT-5`;
}

function fromKey(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function key(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type ResetCalendarDay = {
  key: string;
  date: Date;
  future: boolean;
  resets: CodexReset[];
  resetType: CodexReset['resetType'] | null;
};

export type ResetCalendar = {
  weeks: ResetCalendarDay[][];
  monthLabels: { column: number; label: string }[];
};

export function buildResetCalendar(resets: CodexReset[], now = new Date()): ResetCalendar {
  const todayKey = bogotaDateKey(now);
  const today = fromKey(todayKey);
  const currentSunday = new Date(today.getTime() - today.getUTCDay() * DAY_MS);
  const start = new Date(currentSunday.getTime() - (WEEKS - 1) * 7 * DAY_MS);
  const byDay = new Map<string, CodexReset[]>();
  for (const reset of resets) {
    const dateKey = bogotaDateKey(reset.announcedAt);
    byDay.set(dateKey, [...(byDay.get(dateKey) ?? []), reset]);
  }

  const weeks = Array.from({ length: WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = new Date(start.getTime() + (week * 7 + weekday) * DAY_MS);
      const dateKey = key(date);
      const matches = byDay.get(dateKey) ?? [];
      return {
        key: dateKey,
        date,
        future: dateKey > todayKey,
        resets: matches,
        resetType:
          matches.length === 0
            ? null
            : matches.some((reset) => reset.resetType === 'banked')
              ? 'banked'
              : 'regular',
      } satisfies ResetCalendarDay;
    }),
  );

  const monthLabels: ResetCalendar['monthLabels'] = [
    { column: 0, label: monthName.format(weeks[0][0].date) },
  ];
  weeks.forEach((week, column) => {
    const firstOfMonth = week.find((day) => day.date.getUTCDate() === 1);
    if (firstOfMonth) {
      monthLabels.push({ column, label: monthName.format(firstOfMonth.date) });
    }
  });
  return { weeks, monthLabels };
}
