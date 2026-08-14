import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_PORTFOLIO } from '@/features/investing/data/portfolio';
import { Positions } from '@/features/investing/ui/Positions';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Positions', () => {
  it('puts the portfolio total and its return above the position controls', () => {
    render(
      <Positions
        portfolio={{
          version: 1,
          positions: [{ symbol: 'AAPL', quantity: 2, averageCost: 100 }],
        }}
        quotes={
          new Map([
            [
              'AAPL',
              {
                symbol: 'AAPL',
                price: 125,
                currency: 'USD',
                previousClose: 120,
                change: 5,
                changePercent: 4.17,
                provider: 'test',
                marketState: 'REGULAR',
                name: 'Apple Inc.',
                extended: false,
              },
            ],
          ])
        }
        selected="AAPL"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />,
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
    const { container } = render(
      <Positions
        portfolio={{
          version: 1,
          positions: [
            { symbol: 'AAPL', quantity: 1, averageCost: 100 },
            { symbol: 'MSFT', quantity: 1, averageCost: 200 },
          ],
        }}
        quotes={new Map()}
        selected="AAPL"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onMove={onMove}
      />,
    );

    const rows = container.querySelectorAll('li[draggable="true"]');
    fireEvent.dragStart(rows[0]);
    fireEvent.drop(rows[1]);

    expect(onMove).toHaveBeenCalledWith('AAPL', 'MSFT');
  });
});
