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
  fireEvent.pointerEnter(selectedDay, { pointerType: 'mouse' });
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');
  expect(detail).toHaveTextContent('Sep 29, 2026, 2:00 PM GMT-5');
  expect(Array.from(detail?.children ?? [], (item) => item.tagName)).toEqual(['STRONG', 'SMALL']);
  expect(detail?.textContent).toBe('1 banked reset on 2026-09-29Sep 29, 2026, 2:00 PM GMT-5');
  expect(detail).not.toHaveTextContent('·');
  expect(detail).not.toHaveTextContent(reset.text);
  expect(within(detail as HTMLElement).queryByRole('link', { name: 'View on X' })).toBeNull();
  expect(history.querySelector('[data-content*="View on X"]')).toBeNull();
  expect(history.querySelector('[data-content*="This post description"]')).toBeNull();

  fireEvent.pointerLeave(selectedDay.closest('[class*="chart"]')!, { pointerType: 'mouse' });
  fireEvent.focus(within(history).getByRole('button', { name: 'No reset on 2026-09-28' }));
  fireEvent.keyDown(within(history).getByRole('button', { name: 'No reset on 2026-09-28' }), {
    key: 'Tab',
  });
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

  fireEvent.pointerEnter(screen.getByRole('button', { name: '2 banked resets on 2026-09-29' }), {
    pointerType: 'mouse',
  });
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

it('highlights a reset day only while the calendar is hovered or focused', () => {
  render(<ResetCalendar resets={[reset]} now={new Date('2026-09-29T20:00:00Z')} />);

  const history = screen.getByRole('region', { name: 'Codex reset history' });
  const day = within(history).getByRole('button', { name: '1 banked reset on 2026-09-29' });
  const chart = day.closest('[class*="chart"]')!;
  const detail = history.querySelector('[aria-live="polite"]');

  expect(day).not.toHaveAttribute('data-active');
  expect(detail).toBeEmptyDOMElement();
  fireEvent.pointerEnter(day, { pointerType: 'mouse' });
  expect(day).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');
  fireEvent.pointerLeave(chart, { pointerType: 'mouse' });
  expect(day).not.toHaveAttribute('data-active');
  expect(detail).toBeEmptyDOMElement();

  fireEvent.focus(day);
  fireEvent.keyDown(day, { key: 'Tab' });
  expect(day).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');
  fireEvent.blur(day);
  expect(day).not.toHaveAttribute('data-active');
  expect(detail).toBeEmptyDOMElement();

  fireEvent.pointerEnter(day, { pointerType: 'mouse' });
  fireEvent.pointerDown(day, { pointerType: 'mouse' });
  fireEvent.focus(day);
  fireEvent.pointerLeave(chart, { pointerType: 'mouse' });
  expect(detail).toBeEmptyDOMElement();
});

it('keeps the focused day selected when the pointer leaves another day', () => {
  render(<ResetCalendar resets={[reset]} now={new Date('2026-09-29T20:00:00Z')} />);
  const history = screen.getByRole('region', { name: 'Codex reset history' });
  const focused = within(history).getByRole('button', { name: '1 banked reset on 2026-09-29' });
  const hovered = within(history).getByRole('button', { name: 'No reset on 2026-09-28' });
  const chart = focused.closest('[class*="chart"]')!;
  const detail = history.querySelector('[aria-live="polite"]');

  fireEvent.focus(focused);
  fireEvent.keyDown(focused, { key: 'Tab' });
  fireEvent.pointerEnter(hovered, { pointerType: 'mouse' });
  fireEvent.pointerLeave(chart, { pointerType: 'mouse' });
  expect(focused).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');

  fireEvent.pointerEnter(hovered, { pointerType: 'mouse' });
  fireEvent.blur(focused);
  expect(hovered).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('No reset on 2026-09-28');
});

it('shows the keyboard-focused day when the pointer remains over another day', () => {
  render(<ResetCalendar resets={[reset]} now={new Date('2026-09-29T20:00:00Z')} />);
  const history = screen.getByRole('region', { name: 'Codex reset history' });
  const focused = within(history).getByRole('button', { name: '1 banked reset on 2026-09-29' });
  const hovered = within(history).getByRole('button', { name: 'No reset on 2026-09-28' });
  const detail = history.querySelector('[aria-live="polite"]');

  fireEvent.pointerEnter(hovered, { pointerType: 'mouse' });
  fireEvent.focus(focused);
  fireEvent.keyDown(focused, { key: 'Tab' });
  expect(focused).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');

  fireEvent.pointerMove(hovered, { pointerType: 'mouse' });
  expect(hovered).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('No reset on 2026-09-28');
});

it('uses touch selection until the next touch outside the calendar', () => {
  render(<ResetCalendar resets={[reset]} now={new Date('2026-09-29T20:00:00Z')} />);
  const history = screen.getByRole('region', { name: 'Codex reset history' });
  const day = within(history).getByRole('button', { name: '1 banked reset on 2026-09-29' });
  const detail = history.querySelector('[aria-live="polite"]');

  fireEvent.pointerDown(day, { pointerType: 'touch' });
  fireEvent.mouseEnter(day);
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');
  fireEvent.pointerDown(document.body, { pointerType: 'touch' });
  expect(detail).toBeEmptyDOMElement();
});

it('opens a day activated by assistive technology without pointer or keyboard events', () => {
  render(<ResetCalendar resets={[reset]} now={new Date('2026-09-29T20:00:00Z')} />);
  const history = screen.getByRole('region', { name: 'Codex reset history' });
  const day = within(history).getByRole('button', { name: '1 banked reset on 2026-09-29' });
  const detail = history.querySelector('[aria-live="polite"]');

  fireEvent.click(day, { detail: 0 });
  expect(day).toHaveAttribute('data-active', 'true');
  expect(detail).toHaveTextContent('1 banked reset on 2026-09-29');
  fireEvent.blur(day);
  expect(detail).toBeEmptyDOMElement();
});
