import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_PORTFOLIO, type Portfolio } from '@/features/investing/data/portfolio';
import {
  EMPTY_WATCHLIST,
  addSymbol,
  type Watchlist as WatchlistData,
} from '@/features/investing/data/watchlist';
import { mergeImportedPositions } from '@/features/investing/lib/positionsFile';
import { Positions } from '@/features/investing/ui/Positions';
import { PositionsTransfer } from '@/features/investing/ui/PositionsTransfer';
import { Watchlist } from '@/features/investing/ui/Watchlist';

describe('PositionsTransfer', () => {
  it('shows imported positions and their symbols in the watchlist', async () => {
    const user = userEvent.setup();
    render(<TransferHarness />);

    await user.upload(
      screen.getByLabelText('Positions file'),
      new File(
        [
          JSON.stringify({
            app: 'edicius-hq',
            kind: 'investing-positions',
            version: 1,
            exportedAt: '2026-08-31T12:00:00.000Z',
            positions: [{ symbol: 'MSFT', quantity: 2, averageCost: 400 }],
          }),
        ],
        'positions.json',
        { type: 'application/json' },
      ),
    );

    expect(
      within(await screen.findByRole('list', { name: 'Positions' })).getByRole('button', {
        name: /^MSFT/,
      }),
    ).toBeInTheDocument();
    expect(
      within(await screen.findByRole('list', { name: 'Watchlist' })).getByText('MSFT'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 positions imported, 0 updated.')).toBeInTheDocument();
  });
});

function TransferHarness() {
  const [portfolio, setPortfolio] = useState<Portfolio>(EMPTY_PORTFOLIO);
  const [watchlist, setWatchlist] = useState<WatchlistData>(EMPTY_WATCHLIST);

  return (
    <>
      <PositionsTransfer
        portfolio={portfolio}
        disabled={false}
        onImport={async (positions) => {
          const merged = mergeImportedPositions(portfolio, positions);
          setPortfolio(merged.portfolio);
          setWatchlist((current) =>
            positions.reduce((next, position) => addSymbol(next, position.symbol), current),
          );
          return merged;
        }}
      />
      <Positions
        portfolio={portfolio}
        quotes={new Map()}
        selected="AAPL"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />
      <Watchlist
        entries={watchlist.entries}
        quotes={new Map()}
        selected="AAPL"
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />
    </>
  );
}
