import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PriceAlert } from '@/features/investing/data/priceAlerts';
import type { Quote } from '@/shared/api/market';

import { PriceAlerts } from './PriceAlerts';

afterEach(() => cleanup());

function alert(over: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: 'a1',
    symbol: 'AAPL',
    kind: 'buy',
    price: 200,
    active: true,
    createdAt: 0,
    triggeredAt: null,
    ...over,
  };
}

function quote(price: number): Quote {
  return {
    symbol: 'AAPL',
    price,
    currency: 'USD',
    previousClose: price,
    change: 0,
    changePercent: 0,
    provider: 'test',
    time: 0,
    marketState: 'REGULAR',
    name: 'Apple',
    extended: false,
  };
}

function renderPanel(over: Partial<React.ComponentProps<typeof PriceAlerts>> = {}) {
  const handlers = {
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    onToggle: vi.fn(),
  };
  const utils = render(
    <PriceAlerts alerts={[]} quotes={new Map()} defaultSymbol="AAPL" {...handlers} {...over} />,
  );
  return { ...utils, ...handlers };
}

describe('PriceAlerts list', () => {
  it('shows the empty state when there are none', () => {
    renderPanel();
    expect(screen.getByText(/No alerts yet/)).toBeInTheDocument();
  });

  it('shows a buy and a sell row, each with its verb and price', () => {
    renderPanel({
      alerts: [alert({ kind: 'buy', price: 200 }), alert({ id: 'a2', kind: 'sell', price: 260 })],
    });

    expect(screen.getByText(/Buy \$?200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Sell \$?260\.00/)).toBeInTheDocument();
  });

  it('shows when a fired alert went off, and reads it as reactivatable', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderPanel({
      alerts: [alert({ active: false, triggeredAt: new Date('2026-09-02T14:32:00').getTime() })],
    });

    expect(screen.getByText(/Fired/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Turn on/ }));
    expect(onToggle).toHaveBeenCalledWith('a1', true);
  });

  it('removes an alert on the remove control', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderPanel({ alerts: [alert()] });

    await user.click(screen.getByRole('button', { name: /Remove/ }));
    expect(onRemove).toHaveBeenCalledWith('a1');
  });

  it('edits the price of an existing alert without needing to pick the symbol again', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderPanel({ alerts: [alert()] });

    await user.click(screen.getByRole('button', { name: /Edit/ }));
    const price = screen.getByLabelText('Price');
    await user.clear(price);
    await user.type(price, '210');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdate).toHaveBeenCalledWith('a1', { symbol: 'AAPL', kind: 'buy', price: 210 });
  });
});

describe('PriceAlerts add form', () => {
  it('creates an alert once a symbol, kind and price are given', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Add alert' }));
    // Enter with nothing chosen from the list follows the typed symbol
    // directly — see `SymbolSearch`.
    await user.type(screen.getByLabelText('Search a symbol'), 'MSFT{Enter}');
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.type(screen.getByLabelText('Price'), '410');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAdd).toHaveBeenCalledWith({ symbol: 'MSFT', kind: 'sell', price: 410 });
  });

  it('refuses a buy target the current quote has already reached, and explains why', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPanel({ quotes: new Map([['AAPL', quote(190)]]) });

    await user.click(screen.getByRole('button', { name: 'Add alert' }));
    await user.type(screen.getByLabelText('Search a symbol'), 'AAPL{Enter}');
    // Kind defaults to buy.
    await user.type(screen.getByLabelText('Price'), '200');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/already at or below/);
  });

  it('allows a target the current quote has not reached yet', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPanel({ quotes: new Map([['AAPL', quote(210)]]) });

    await user.click(screen.getByRole('button', { name: 'Add alert' }));
    await user.type(screen.getByLabelText('Search a symbol'), 'AAPL{Enter}');
    await user.type(screen.getByLabelText('Price'), '200');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onAdd).toHaveBeenCalledWith({ symbol: 'AAPL', kind: 'buy', price: 200 });
  });

  it('closes without saving on cancel', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Add alert' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Add alert' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Price')).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
