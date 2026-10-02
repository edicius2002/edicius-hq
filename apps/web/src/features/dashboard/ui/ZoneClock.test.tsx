import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { ZoneClock } from './ZoneClock';

afterEach(() => vi.useRealTimers());

it('shows each named zone in 24-hour time and advances with the minute', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T15:04:00Z'));

  render(
    <>
      <ZoneClock label="PT" timeZone="America/Los_Angeles" />
      <ZoneClock label="PST" timeZone="Etc/GMT+8" />
      <ZoneClock label="EST" timeZone="America/New_York" />
      <ZoneClock label="PER" timeZone="America/Lima" />
      <ZoneClock label="ARG" timeZone="America/Argentina/Buenos_Aires" />
    </>,
  );

  for (const name of ['PT 08:04', 'PST 07:04', 'EST 11:04', 'PER 10:04', 'ARG 12:04']) {
    expect(screen.getByLabelText(name)).toBeInTheDocument();
  }

  act(() => vi.advanceTimersByTime(60_000));

  for (const name of ['PT 08:05', 'PST 07:05', 'EST 11:05', 'PER 10:05', 'ARG 12:05']) {
    expect(screen.getByLabelText(name)).toBeInTheDocument();
  }
});

it('stops refreshing after unmount', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T15:04:00Z'));
  const { unmount } = render(<ZoneClock label="PT" timeZone="America/Los_Angeles" />);

  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('draws four seven-segment digits and a blinking colon while retaining the time label', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T15:04:00Z'));

  const { container } = render(<ZoneClock label="PT" timeZone="America/Los_Angeles" />);
  const clock = screen.getByLabelText('PT 08:04');
  const digits = container.querySelectorAll('svg[data-digit]');
  const colon = container.querySelector('[data-testid="clock-colon"]');

  expect(clock.tagName).toBe('TIME');
  expect(digits).toHaveLength(4);
  expect([...digits].map((digit) => digit.getAttribute('data-digit')).join('')).toBe('0804');
  expect(colon).toHaveAttribute('aria-hidden', 'true');
  expect(colon?.className).toMatch(/colon/);
});

it('keeps PST fixed at UTC−8 while PT follows the US winter offset', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T15:04:00Z'));

  render(
    <>
      <ZoneClock label="PT" timeZone="America/Los_Angeles" />
      <ZoneClock label="PST" timeZone="Etc/GMT+8" />
      <ZoneClock label="EST" timeZone="America/New_York" />
    </>,
  );

  expect(screen.getByLabelText('PT 07:04')).toBeInTheDocument();
  expect(screen.getByLabelText('PST 07:04')).toBeInTheDocument();
  expect(screen.getByLabelText('EST 10:04')).toBeInTheDocument();
});
