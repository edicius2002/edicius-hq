import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { MarketRail } from '@/features/investing/ui/MarketRail';

describe('MarketRail', () => {
  it('shows one compact market view at a time', async () => {
    const user = userEvent.setup();

    render(
      <MarketRail
        regime="regular"
        statusLabel="Market open"
        watchlist={<p>Followed symbols</p>}
        positions={<p>Held positions</p>}
      />,
    );

    const watchlist = screen.getByRole('tab', { name: 'Watchlist' });
    const positions = screen.getByRole('tab', { name: 'Positions' });

    expect(watchlist).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Watchlist' })).toHaveTextContent(
      'Followed symbols',
    );
    expect(screen.queryByRole('tabpanel', { name: 'Positions' })).not.toBeInTheDocument();

    await user.click(positions);

    expect(positions).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Positions' })).toHaveTextContent('Held positions');
    expect(screen.queryByRole('tabpanel', { name: 'Watchlist' })).not.toBeInTheDocument();
  });

  it('can leave the chart as the only workspace panel', () => {
    render(
      <MarketRail
        regime="closed"
        statusLabel="Market closed"
        watchlist={<p>Followed symbols</p>}
        positions={<p>Held positions</p>}
        hidden
      />,
    );

    expect(screen.queryByRole('region', { name: 'Markets' })).not.toBeInTheDocument();
  });
});
