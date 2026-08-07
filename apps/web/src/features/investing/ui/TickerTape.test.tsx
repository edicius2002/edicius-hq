import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { loopDuration, tapeCycle } from '@/features/investing/lib/tape';
import { TickerTape } from '@/features/investing/ui/TickerTape';
import type { Quote } from '@/shared/api/market';

function quote(symbol: string, over: Partial<Quote> = {}): Quote {
  return {
    symbol,
    price: 100,
    currency: 'USD',
    previousClose: 99,
    change: 1,
    changePercent: 1.01,
    provider: 'test',
    marketState: 'REGULAR',
    name: symbol,
    extended: false,
    ...over,
  };
}

/** The visible half; the trailing copy is `aria-hidden` and must not be found. */
function visibleTape() {
  return screen.getByLabelText('Ticker tape');
}

describe('TickerTape', () => {
  it('renders nothing without quotes', () => {
    const { container } = render(<TickerTape quotes={[]} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each symbol once to assistive tech, despite looping twice', () => {
    render(<TickerTape quotes={[quote('AAPL'), quote('MSFT')]} onSelect={vi.fn()} />);

    // The duplicate half is what makes the loop seamless; announcing every
    // symbol twice would be the price of that, so it is hidden instead.
    expect(within(visibleTape()).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /AAPL/ })).toBeInTheDocument();
  });

  it('charts the symbol that was clicked', async () => {
    const onSelect = vi.fn();
    render(<TickerTape quotes={[quote('AAPL'), quote('MSFT')]} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('button', { name: /MSFT/ }));

    expect(onSelect).toHaveBeenCalledWith('MSFT');
  });

  it('keeps the duplicated half out of the tab order', () => {
    const { container } = render(<TickerTape quotes={[quote('AAPL')]} onSelect={vi.fn()} />);

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons[0].getAttribute('tabindex')).toBeNull();
    expect(buttons.slice(1).every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('holds the speed constant by deriving the loop from the measured width', () => {
    // What is fixed is pixels per second, so a wider group must take
    // proportionally longer. Doubling the width doubles the duration.
    expect(loopDuration(1300)).toBe(10);
    expect(loopDuration(2600)).toBe(20);
  });

  it('falls back to a duration rather than freezing before the first measure', () => {
    // jsdom reports every element as zero-sized, and so does a real browser
    // for one frame; a zero width must not become a zero-second animation.
    expect(loopDuration(0)).toBe(30);
    expect(loopDuration(Number.NaN)).toBe(30);
  });

  it('repeats a short list so the loop has no gap to drag across the frame', () => {
    // The loop translates exactly one group, so a group narrower than the
    // frame would show empty space where the next copy has not arrived yet.
    expect(tapeCycle(['A', 'B'])).toHaveLength(12);
    expect(tapeCycle(['A', 'B', 'C', 'D', 'E'])).toHaveLength(15);
    expect(tapeCycle([])).toHaveLength(0);
  });

  it('leaves only the first pass through the symbols reachable', () => {
    const { container } = render(
      <TickerTape quotes={[quote('AAPL'), quote('MSFT')]} onSelect={vi.fn()} />,
    );

    // 2 symbols repeated to 12, twice over — but only the two real ones are
    // announced and focusable; the rest are there to fill the line.
    expect(container.querySelectorAll('button')).toHaveLength(24);
    expect(
      [...container.querySelectorAll('button')].filter((b) => !b.hasAttribute('tabindex')),
    ).toHaveLength(2);
  });

  it('marks a price that came from an extended session', () => {
    const { container } = render(
      <TickerTape quotes={[quote('AAPL', { extended: true })]} onSelect={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /AAPL/ })).toHaveAttribute(
      'title',
      'AAPL — extended hours',
    );
    expect(container.querySelector('button')?.className).toMatch(/extended/);
  });
});
