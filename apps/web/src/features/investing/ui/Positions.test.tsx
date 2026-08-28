import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_PORTFOLIO } from '@/features/investing/data/portfolio';
import { PositionTotals, Positions } from '@/features/investing/ui/Positions';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Positions', () => {
  it('keeps the portfolio total separate from the position controls', () => {
    render(
      <>
        <PositionTotals
          totals={[
            { currency: 'USD', cost: 200, value: 250, profit: 50, profitPercent: 25, positions: 1 },
          ]}
        />
        <Positions
          portfolio={EMPTY_PORTFOLIO}
          quotes={new Map()}
          selected="AAPL"
          onSelect={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          onMove={vi.fn()}
        />
      </>,
    );

    const total = screen.getByLabelText('Total USD');
    const add = screen.getByRole('button', { name: 'Add position' });

    expect(total).toHaveTextContent('250.00');
    expect(total).toHaveTextContent('+50.00 · +25.00%');
    expect(total.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('adds a position from an empty portfolio', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [
            { symbol: 'MSFT', name: 'Microsoft Corporation', kind: 'Equity', exchange: 'NASDAQ' },
          ],
        }),
      ),
    );

    render(
      <Positions
        portfolio={EMPTY_PORTFOLIO}
        quotes={new Map()}
        selected="AAPL"
        onSelect={vi.fn()}
        onEdit={onEdit}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    expect(screen.getByText('Nothing held yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add position' }));
    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'ms');
    await user.click(await screen.findByRole('button', { name: /MSFT Microsoft Corporation/i }));
    expect(screen.getByText('Selected: MSFT')).toBeInTheDocument();
    await user.type(screen.getByRole('spinbutton', { name: 'Position quantity' }), '1.5');
    await user.type(screen.getByRole('spinbutton', { name: 'Position average cost' }), '412.25');
    await user.click(screen.getByRole('button', { name: 'Save position' }));

    expect(onEdit).toHaveBeenCalledWith('MSFT', 1.5, 412.25);
    expect(screen.getByRole('button', { name: 'Add position' })).toBeInTheDocument();
  });

  it('keeps save disabled until a ticker and values are selected', async () => {
    const user = userEvent.setup();

    render(
      <Positions
        portfolio={EMPTY_PORTFOLIO}
        quotes={new Map()}
        selected="AAPL"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add position' }));
    const save = screen.getByRole('button', { name: 'Save position' });
    expect(save).toBeDisabled();

    await user.type(screen.getByRole('spinbutton', { name: 'Position quantity' }), '1');
    await user.type(screen.getByRole('spinbutton', { name: 'Position average cost' }), '0');

    expect(save).toBeDisabled();
  });

  it('continues to save edits under the existing position ticker', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();

    render(
      <Positions
        portfolio={{
          version: 1,
          positions: [{ symbol: 'AAPL', quantity: 1, averageCost: 100 }],
        }}
        quotes={new Map()}
        selected="AAPL"
        onSelect={vi.fn()}
        onEdit={onEdit}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit AAPL position' }));
    const quantity = screen.getByRole('spinbutton', { name: 'AAPL position quantity' });
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Save AAPL position' }));

    expect(onEdit).toHaveBeenCalledWith('AAPL', 2, 100);
  });

  it('reorders positions by drag and drop', () => {
    const onMove = vi.fn();
    const { container } = render(<ThreeHoldings onMove={onMove} />);

    const rows = container.querySelectorAll('li[draggable="true"]');
    fireEvent.dragStart(rows[0]);
    fireEvent.drop(rows[1]);

    expect(onMove).toHaveBeenCalledWith('AAPL', 'MSFT');
  });

  /*
   * The cards wrap into a grid, so left and right are the axis a reader
   * follows along a row. Both pairs of arrows mean one place earlier or later,
   * for the reason `useReorder` records: how many cards a row holds is decided
   * by `auto-fill` against the current width, so "a row up" is a different
   * distance at every window size. jsdom lays nothing out, so what these can
   * check is the callback, not where the card lands on screen.
   */
  it('moves a card one place later with Alt and the right arrow', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<ThreeHoldings onMove={onMove} />);

    screen.getByRole('button', { name: /^MSFT/ }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('MSFT', 'NVDA');
  });

  it('moves a card one place earlier with Alt and the left arrow', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<ThreeHoldings onMove={onMove} />);

    screen.getByRole('button', { name: /^MSFT/ }).focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('MSFT', 'AAPL');
  });

  it('keeps the up and down arrows a reader already knows from the watchlist', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<ThreeHoldings onMove={onMove} />);

    screen.getByRole('button', { name: /^MSFT/ }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('MSFT', 'NVDA');
    expect(screen.getByRole('button', { name: /^MSFT/ }).closest('li')).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight',
    );
  });
});

/** Three unvalued holdings, which is enough to have a middle one to move. */
function ThreeHoldings({ onMove }: { onMove: (from: string, to: string) => void }) {
  return (
    <Positions
      portfolio={{
        version: 1,
        positions: [
          { symbol: 'AAPL', quantity: 1, averageCost: 100 },
          { symbol: 'MSFT', quantity: 1, averageCost: 200 },
          { symbol: 'NVDA', quantity: 1, averageCost: 300 },
        ],
      }}
      quotes={new Map()}
      selected="AAPL"
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onMove={onMove}
    />
  );
}
