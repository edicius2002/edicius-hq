import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';

import type { CodexReset } from '@/shared/api/codexResets';

import { ResetCalendar } from './ResetCalendar';

const reset: CodexReset = {
  id: 'banked-reset',
  resetType: 'banked',
  announcedAt: '2026-09-29T19:00:00Z',
  text: 'This post description should be hidden',
  source: {
    type: 'x_post',
    author: 'thsottiaux',
    url: 'https://x.com/thsottiaux/status/banked-reset',
  },
};

it('shows reset dates and times without location suffixes, post text, or post links', () => {
  render(<ResetCalendar resets={[reset]} now={new Date('2026-09-29T20:00:00Z')} />);

  const history = screen.getByRole('region', { name: 'Codex reset history' });
  const selectedDay = within(history).getByRole('button', {
    name: '1 banked reset on 2026-09-29',
  });
  expect(selectedDay).toHaveAttribute('aria-pressed', 'true');
  expect(within(history).getByLabelText('No reset on 2026-09-28')).toBeInTheDocument();
  expect(within(history).getByLabelText('2026-09-30, future date')).toBeInTheDocument();
  expect(history).not.toHaveTextContent('Bogotá');
  expect(history.querySelector('[aria-label*="Bogotá"]')).toBeNull();

  const detail = history.querySelector('[aria-live="polite"]');
  expect(detail).not.toBeNull();
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');
  expect(detail).toHaveTextContent('Sep 29, 2026, 2:00 PM GMT-5');
  expect(Array.from(detail?.children ?? [], (item) => item.tagName)).toEqual(['STRONG', 'SMALL']);
  expect(detail?.textContent).toBe('1 banked reset on 2026-09-29Sep 29, 2026, 2:00 PM GMT-5');
  expect(detail).not.toHaveTextContent('·');
  expect(detail).not.toHaveTextContent(reset.text);
  expect(within(detail as HTMLElement).queryByRole('link', { name: 'View on X' })).toBeNull();
  expect(history.querySelector('[data-content*="View on X"]')).toBeNull();
  expect(history.querySelector('[data-content*="This post description"]')).toBeNull();

  fireEvent.focus(within(history).getByRole('button', { name: 'No reset on 2026-09-28' }));
  expect(within(history).getByRole('button', { name: 'No reset on 2026-09-28' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('keeps multiple reset times alongside the selected day label without text separators', () => {
  const earlierReset: CodexReset = {
    ...reset,
    id: 'earlier-reset',
    announcedAt: '2026-09-29T18:00:00Z',
  };
  render(<ResetCalendar resets={[earlierReset, reset]} now={new Date('2026-09-29T20:00:00Z')} />);

  const detail = screen
    .getByRole('region', { name: 'Codex reset history' })
    .querySelector('[aria-live="polite"]');
  expect(Array.from(detail?.children ?? [], (item) => item.tagName)).toEqual([
    'STRONG',
    'SMALL',
    'SMALL',
  ]);
  expect(detail?.textContent).toBe(
    '2 banked resets on 2026-09-29Sep 29, 2026, 1:00 PM GMT-5Sep 29, 2026, 2:00 PM GMT-5',
  );
  expect(detail).not.toHaveTextContent('·');
});

it('omits a month label when the following month starts in the same week', () => {
  render(<ResetCalendar resets={[]} now={new Date('2026-09-29T20:00:00Z')} />);

  const history = screen.getByRole('region', { name: 'Codex reset history' });
  expect(history.querySelector('span[style*="grid-row: 1"]')).toHaveTextContent('Oct');
});
