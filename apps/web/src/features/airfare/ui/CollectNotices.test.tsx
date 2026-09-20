import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NOTICE_LIFE_MS, type CollectNotice } from '@/features/airfare/lib/collectNotice';
import { CollectNotices } from '@/features/airfare/ui/CollectNotices';

function card(overrides: Partial<CollectNotice> = {}): CollectNotice {
  return {
    id: 'LIM|CUZ|2026-10',
    routeId: 'LIM-CUZ',
    title: 'LIM → CUZ · October 2026',
    kind: 'success',
    text: 'Collection complete: 2 departures checked, 1 updated.',
    ...overrides,
  };
}

describe('the card a finished press leaves in the corner', () => {
  it('names the watch and repeats its sentence', () => {
    render(<CollectNotices notices={[card()]} />);
    expect(screen.getByText('LIM → CUZ · October 2026')).toBeInTheDocument();
    expect(screen.getByText(/2 departures checked/)).toBeInTheDocument();
  });

  it('marks a refusal as one', () => {
    render(
      <CollectNotices notices={[card({ kind: 'error', text: 'Collection failed. Try again.' })]} />,
    );
    expect(screen.getByText('Collection failed. Try again.').closest('div')?.className).toMatch(
      /refused/,
    );
  });

  it('stacks a card per row, newest last', () => {
    render(
      <CollectNotices
        notices={[
          card({ id: 'a', title: 'LIM → CUZ · October 2026' }),
          card({ id: 'b', title: 'LIM → MAD · December 2026' }),
        ]}
      />,
    );
    const stack = screen.getByTestId('collect-notices');
    expect([...stack.children].map((node) => node.firstElementChild?.textContent)).toEqual([
      'LIM → CUZ · October 2026',
      'LIM → MAD · December 2026',
    ]);
  });

  it('fades on the clock the hook dismisses it by, not one of its own', () => {
    // The card is taken out of the document by a timer in `useRouteCollection`
    // and faded out by a CSS animation. Two independently written durations
    // would eventually disagree and leave a card either blinking out at full
    // opacity or sitting invisible in the corner, so the stylesheet is handed
    // the same constant the timer runs on.
    render(<CollectNotices notices={[card()]} />);
    const stack = screen.getByTestId('collect-notices');
    expect((stack.firstElementChild as HTMLElement).style.getPropertyValue('--notice-life')).toBe(
      `${NOTICE_LIFE_MS}ms`,
    );
  });

  it('announces accepted/success politely and failures assertively', () => {
    const { rerender } = render(<CollectNotices notices={[card({ kind: 'accepted' })]} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByTestId('collect-notices')).not.toHaveAttribute('aria-hidden');

    rerender(<CollectNotices notices={[card({ kind: 'error' })]} />);
    expect(screen.getByRole('alert')).toHaveAttribute('aria-atomic', 'true');
  });

  it('costs no element when there is nothing to say', () => {
    render(<CollectNotices notices={[]} />);
    expect(screen.queryByTestId('collect-notices')).not.toBeInTheDocument();
  });
});
