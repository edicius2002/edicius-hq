import { useEffect, useRef } from 'react';

import {
  openChartFocus,
  type ChartFocusMessage,
  type ChartFocusPublisher,
} from '@/features/investing/data/supabaseMarket';

export const CHART_FOCUS_HEARTBEAT_MS = 15_000;

export type ChartFocusInput = {
  symbol: string;
  timeframe: string;
  extended: boolean;
  active?: boolean;
};

/** Advertise the one chart this tab is showing, with an expiring lease. */
export function useChartFocus(input: ChartFocusInput): void {
  const clientId = useRef<string | undefined>(undefined);
  if (!clientId.current) clientId.current = crypto.randomUUID();

  const { symbol, timeframe, extended, active = true } = input;
  useEffect(() => {
    if (!active || !symbol) return;
    let disposed = false;
    let publisher: ChartFocusPublisher | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const client = clientId.current as string;
    const focus: ChartFocusMessage = {
      clientId: client,
      symbol,
      timeframe,
      extended,
      active: true,
    };

    const send = (target: ChartFocusPublisher, payload: ChartFocusMessage) => {
      void target.publish(payload).catch(() => {});
    };
    void openChartFocus().then(
      (joined) => {
        if (disposed) {
          void joined.close().catch(() => {});
          return;
        }
        publisher = joined;
        send(joined, focus);
        timer = setInterval(() => send(joined, focus), CHART_FOCUS_HEARTBEAT_MS);
      },
      () => {
        // Focus is an optimization for live bars; auth/channel failures must
        // not affect the quote stream or escape through React.
      },
    );

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      if (publisher) {
        void (async () => {
          try {
            await publisher?.publish({ ...focus, active: false });
          } catch {
            // Release is best-effort; always try to remove the channel.
          }
          try {
            await publisher?.close();
          } catch {
            // Cleanup failures must not escape through React.
          }
        })();
      }
    };
  }, [active, extended, symbol, timeframe]);
}
