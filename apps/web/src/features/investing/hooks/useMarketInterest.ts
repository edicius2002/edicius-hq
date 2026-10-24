import { useEffect, useState } from 'react';

import {
  openMarketInterest,
  type MarketInterestPublisher,
} from '@/features/investing/data/supabaseMarket';

export const MARKET_INTEREST_HEARTBEAT_MS = 30_000;

/** Keep a short lease while this page is listening for live quotes. */
export function useMarketInterest(active: boolean): boolean {
  const [clientId] = useState(() => crypto.randomUUID());
  const [available, setAvailable] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const needsQuotes = active && visible;

  useEffect(() => {
    if (!needsQuotes) return;
    let disposed = false;
    let opening = false;
    let publisher: MarketInterestPublisher | undefined;

    const renew = async () => {
      if (disposed || opening) return;
      opening = true;
      try {
        const target = publisher ?? (await openMarketInterest());
        if (disposed) {
          await target.close();
          return;
        }
        publisher = target;
        await target.publish({ clientId, active: true });
        if (!disposed) setAvailable(true);
      } catch {
        if (!disposed) setAvailable(false);
        if (publisher) {
          void publisher.close().catch(() => {});
          publisher = undefined;
        }
      } finally {
        opening = false;
      }
    };

    void renew();
    const timer = setInterval(() => void renew(), MARKET_INTEREST_HEARTBEAT_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      setAvailable(false);
      if (publisher) {
        const target = publisher;
        void (async () => {
          try {
            await target.publish({ clientId, active: false });
          } catch {
            // The server lease also expires if this release cannot be sent.
          }
          await target.close().catch(() => {});
        })();
      }
    };
  }, [needsQuotes, clientId]);

  return needsQuotes && available;
}
