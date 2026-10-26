import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const searchSymbols = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/market', () => ({ searchSymbols }));

import { SymbolSearch } from './SymbolSearch';

afterEach(() => {
  vi.unstubAllGlobals();
  searchSymbols.mockReset();
});

function stubResults(
  results: { symbol: string; name: string; kind: string; exchange: string | null }[],
) {
  searchSymbols.mockResolvedValue({ results });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('SymbolSearch', () => {
  it('dismisses an in-flight search with Escape until the next edit', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ results: [] }>();
    searchSymbols.mockReturnValueOnce(pending.promise).mockResolvedValue({ results: [] });
    render(<SymbolSearch following={new Set()} onPick={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search a symbol' });
    await user.type(input, 'aa');
    await waitFor(() => expect(searchSymbols).toHaveBeenCalledOnce());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ results: [] }));
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    await user.type(input, 'p');
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
  });

  it('never picks an old result after the query changes', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    stubResults([{ symbol: 'MSFT', name: 'Microsoft', kind: 'Equity', exchange: null }]);
    render(<SymbolSearch following={new Set()} onPick={onPick} />);
    const input = screen.getByRole('textbox', { name: 'Search a symbol' });
    await user.type(input, 'ms');
    await screen.findByRole('button', { name: /MSFT Microsoft/i });
    fireEvent.change(input, { target: { value: 'AAPL' } });
    await user.type(input, '{Enter}');
    expect(onPick).toHaveBeenCalledWith('AAPL', 'AAPL');
  });

  it('keeps current results when an older request rejects late', async () => {
    const user = userEvent.setup();
    const old = deferred<{ results: [] }>();
    searchSymbols.mockReturnValueOnce(old.promise).mockResolvedValueOnce({
      results: [{ symbol: 'AAPL', name: 'Apple', kind: 'Equity', exchange: null }],
    });
    render(<SymbolSearch following={new Set()} onPick={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search a symbol' });
    await user.type(input, 'ms');
    await screen.findByText('Searching…');
    await waitFor(() => expect(searchSymbols).toHaveBeenCalledOnce());
    await user.clear(input);
    await user.type(input, 'aa');
    await screen.findByRole('button', { name: /AAPL Apple/i });
    await act(async () => old.reject(new Error('aborted')));
    expect(screen.getByRole('button', { name: /AAPL Apple/i })).toBeInTheDocument();
  });

  it('shows waiting and a retryable error separately from an empty result', async () => {
    const user = userEvent.setup();
    searchSymbols
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ results: [] });
    render(<SymbolSearch following={new Set()} onPick={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Search a symbol' }), 'aa');
    expect(screen.queryByText('Nothing found.')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: /Retry search/i });
    await user.click(screen.getByRole('button', { name: /Retry search/i }));
    await screen.findByText('Nothing found.');
    expect(searchSymbols).toHaveBeenCalledTimes(2);
  });
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
