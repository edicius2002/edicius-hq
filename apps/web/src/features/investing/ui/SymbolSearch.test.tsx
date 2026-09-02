import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolSearch } from './SymbolSearch';

afterEach(() => vi.unstubAllGlobals());

function stubResults(
  results: { symbol: string; name: string; kind: string; exchange: string | null }[],
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ results })),
  );
}

describe('SymbolSearch', () => {
  it('keeps the picked symbol in the field rather than clearing it', async () => {
    const user = userEvent.setup();
    stubResults([
      { symbol: 'MSFT', name: 'Microsoft Corporation', kind: 'Equity', exchange: 'NASDAQ' },
    ]);
    const onPick = vi.fn();

    render(<SymbolSearch following={new Set()} onPick={onPick} />);

    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'ms');
    await user.click(await screen.findByRole('button', { name: /MSFT Microsoft Corporation/i }));

    expect(onPick).toHaveBeenCalledWith('MSFT', 'Microsoft Corporation');
    expect(screen.getByRole('textbox', { name: 'Search a symbol' })).toHaveValue('MSFT');
  });

  it('closes the results list once a symbol is picked', async () => {
    const user = userEvent.setup();
    stubResults([
      { symbol: 'MSFT', name: 'Microsoft Corporation', kind: 'Equity', exchange: 'NASDAQ' },
    ]);

    render(<SymbolSearch following={new Set()} onPick={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'ms');
    await user.click(await screen.findByRole('button', { name: /MSFT Microsoft Corporation/i }));

    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
  });

  it('searches again if the field is edited after a pick', async () => {
    const user = userEvent.setup();
    stubResults([
      { symbol: 'MSFT', name: 'Microsoft Corporation', kind: 'Equity', exchange: 'NASDAQ' },
    ]);

    render(<SymbolSearch following={new Set()} onPick={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'ms');
    await user.click(await screen.findByRole('button', { name: /MSFT Microsoft Corporation/i }));

    stubResults([{ symbol: 'MSTR', name: 'MicroStrategy', kind: 'Equity', exchange: 'NASDAQ' }]);
    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'tr');

    expect(await screen.findByRole('list', { name: 'Search results' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /MSTR MicroStrategy/i })).toBeInTheDocument();
  });

  it('keeps a typed-and-entered symbol in the field the same way a picked one is kept', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();

    render(<SymbolSearch following={new Set()} onPick={onPick} />);

    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'AAPL{Enter}');

    expect(onPick).toHaveBeenCalledWith('AAPL', 'AAPL');
    expect(screen.getByRole('textbox', { name: 'Search a symbol' })).toHaveValue('AAPL');
  });

  it('marks an already-followed symbol rather than offering it again', async () => {
    const user = userEvent.setup();
    stubResults([
      { symbol: 'MSFT', name: 'Microsoft Corporation', kind: 'Equity', exchange: 'NASDAQ' },
    ]);

    render(<SymbolSearch following={new Set(['MSFT'])} onPick={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'ms');
    const hit = await screen.findByRole('button', { name: /MSFT Microsoft Corporation/i });
    expect(hit).toBeDisabled();
  });
});
