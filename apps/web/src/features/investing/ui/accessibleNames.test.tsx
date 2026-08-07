import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Portfolio } from '@/features/investing/data/portfolio';
import type { WatchlistEntry } from '@/features/investing/data/watchlist';
import { Positions } from '@/features/investing/ui/Positions';
import { Watchlist } from '@/features/investing/ui/Watchlist';
import type { Quote } from '@/shared/api/market';

/**
 * The watchlist and the positions sit side by side and hold the same symbols,
 * so their controls are the one place in this app where two different actions
 * can end up with the same name.
 *
 * They did. Both ✕ buttons answered to "Remove PFE", and the first one in the
 * document won — which unfollowed a symbol when the intent was to drop the
 * position. A screen reader user would have had the same two identical choices.
 */

const SYMBOL = 'PFE';

function quotes(): Map<string, Quote> {
  return new Map([
    [
      SYMBOL,
      {
        symbol: SYMBOL,
        price: 26.48,
        currency: 'USD',
        previousClose: 26,
        change: 0.48,
        changePercent: 1.85,
        provider: 'yahoo',
        marketState: 'REGULAR',
        name: 'Pfizer, Inc.',
        extended: false,
      },
    ],
  ]);
}

const entries: WatchlistEntry[] = [{ symbol: SYMBOL, name: 'Pfizer, Inc.' }];
const portfolio: Portfolio = {
  version: 1,
  positions: [{ symbol: SYMBOL, quantity: 2, averageCost: 26.159 }],
};

function renderBoth() {
  return render(
    <>
      <Watchlist
        entries={entries}
        quotes={quotes()}
        selected={SYMBOL}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />
      <Positions
        portfolio={portfolio}
        quotes={quotes()}
        selected={SYMBOL}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    </>,
  );
}

describe('the two lists, side by side', () => {
  it('gives every control a name of its own', () => {
    const { container } = renderBoth();

    const names = [...container.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
    );
    const duplicated = names.filter((name, index) => name && names.indexOf(name) !== index);

    expect(duplicated).toEqual([]);
  });

  it('says which list it is removing from', () => {
    renderBoth();

    // Unambiguous by name alone, so neither a reader nor a query has to know
    // which one came first in the document.
    expect(screen.getByRole('button', { name: 'Stop following PFE' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove PFE position' })).toBeInTheDocument();
  });

  it('names the two prices apart as well', () => {
    renderBoth();

    // Both lists show a PFE price; the button that charts it must not be
    // confusable with the one that opens the position for editing.
    expect(screen.getByRole('button', { name: 'Edit PFE position' })).toBeInTheDocument();
  });
});
