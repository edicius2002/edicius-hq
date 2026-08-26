import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NOTICE_LIFE_MS, type CollectNotice } from '@/features/airfare/lib/collectNotice';
import { CollectNotices } from '@/features/airfare/ui/CollectNotices';

function card(overrides: Partial<CollectNotice> = {}): CollectNotice {
  return {
    id: 'LIM|CUZ|2026-10',
    title: 'LIM → CUZ · October 2026',
    report: {
      ok: true,
      text: 'Collected: 2 departures looked at, cheapest $380.00 on 21/10/2026 — nothing new to record.',
    },
    ...overrides,
  };
}

describe('the card a finished press leaves in the corner', () => {
  it('names the watch and repeats its sentence', () => {
    render(<CollectNotices notices={[card()]} />);
    expect(screen.getByText('LIM → CUZ · October 2026')).toBeInTheDocument();
    expect(screen.getByText(/2 departures looked at/)).toBeInTheDocument();
  });

  it('marks a refusal as one', () => {
    render(
      <CollectNotices
        notices={[card({ report: { ok: false, text: 'The pass failed: upstream said no' } })]}
      />,
    );
    expect(screen.getByText('The pass failed: upstream said no').closest('div')?.className).toMatch(
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

  it('is drawn and never read aloud', () => {
    /*
     * The one accessibility decision here, and it is to add nothing.
     *
     * This is the same sentence the row's own `<p aria-live="polite">` is
     * given in the same commit — the hook writes the report and raises the
     * card together. A second live region would announce every finished pass
     * twice, which is the fault the progress bars already avoid by staying out
     * of the accessibility tree. The row is the channel that speaks; this is
     * the channel that can be seen from the other end of the page, and it
     * holds nothing focusable so nothing is stranded behind `aria-hidden`.
     */
    render(<CollectNotices notices={[card()]} />);
    expect(screen.getByTestId('collect-notices')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('collect-notices').querySelector('button')).toBeNull();
  });

  it('costs no element when there is nothing to say', () => {
    render(<CollectNotices notices={[]} />);
    expect(screen.queryByTestId('collect-notices')).not.toBeInTheDocument();
  });
});
