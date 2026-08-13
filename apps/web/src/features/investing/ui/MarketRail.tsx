import { useState, type ReactNode } from 'react';

import type { Regime } from '@/features/investing/lib/session';
import { Panel } from '@/shared/ui/Panel';

import styles from './InvestingPage.module.css';

type MarketTab = 'watchlist' | 'positions';

type MarketRailProps = {
  regime: Regime;
  statusLabel: string;
  watchlist: ReactNode;
  positions: ReactNode;
  hidden?: boolean;
};

/**
 * The secondary market information shares one compact rail.
 *
 * Keeping both long lists mounted preserves an in-progress position form when
 * the user checks the watchlist, while the hidden tab stays out of layout and
 * the accessibility tree.
 */
export function MarketRail({
  regime,
  statusLabel,
  watchlist,
  positions,
  hidden = false,
}: MarketRailProps) {
  const [activeTab, setActiveTab] = useState<MarketTab>('watchlist');

  return (
    <Panel id="market-panel" className={styles.side} aria-label="Markets" hidden={hidden}>
      <div className={styles.railHeader}>
        <div className={styles.marketTabs} role="tablist" aria-label="Market panel">
          <button
            type="button"
            id="market-tab-watchlist"
            className={`${styles.marketTab} ${activeTab === 'watchlist' ? styles.marketTabOn : ''}`}
            role="tab"
            aria-selected={activeTab === 'watchlist'}
            aria-controls="market-panel-watchlist"
            onClick={() => setActiveTab('watchlist')}
          >
            Watchlist
          </button>
          <button
            type="button"
            id="market-tab-positions"
            className={`${styles.marketTab} ${activeTab === 'positions' ? styles.marketTabOn : ''}`}
            role="tab"
            aria-selected={activeTab === 'positions'}
            aria-controls="market-panel-positions"
            onClick={() => setActiveTab('positions')}
          >
            Positions
          </button>
        </div>

        <span className={`${styles.regime} ${styles[regime]}`}>{statusLabel}</span>
      </div>

      <div
        id="market-panel-watchlist"
        className={styles.tabPanel}
        role="tabpanel"
        aria-labelledby="market-tab-watchlist"
        hidden={activeTab !== 'watchlist'}
      >
        {watchlist}
      </div>

      <div
        id="market-panel-positions"
        className={styles.tabPanel}
        role="tabpanel"
        aria-labelledby="market-tab-positions"
        hidden={activeTab !== 'positions'}
      >
        {positions}
      </div>
    </Panel>
  );
}
