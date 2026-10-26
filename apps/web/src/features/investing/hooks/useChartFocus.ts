import { useEffect, useState } from 'react';

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
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const { symbol, timeframe, extended, active = true } = input;
  useEffect(() => {
    if (!active || !visible || !symbol) return;
    const clientId = crypto.randomUUID();
    let disposed = false;
    let publisher: ChartFocusPublisher | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const focus: ChartFocusMessage = {
      clientId,
      symbol,
      timeframe,
      extended,
      active: true,
    };

    const scheduleRetry = () => {
      if (disposed || retryTimer) return;
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          open();
        },
        Math.min(15_000, 1_000 * 2 ** attempt),
      );
      attempt += 1;
    };
    const send = (target: ChartFocusPublisher, payload: ChartFocusMessage) => {
      void target.publish(payload).catch(() => {
        if (disposed || publisher !== target) return;
        publisher = undefined;
        if (timer) clearInterval(timer);
        timer = undefined;
        void target.close().catch(() => {});
        scheduleRetry();
      });
    };
    const open = () =>
      void openChartFocus().then(
        (joined) => {
          if (disposed) {
            void joined.close().catch(() => {});
            return;
          }
          publisher = joined;
          attempt = 0;
          send(joined, focus);
          timer = setInterval(() => send(joined, focus), CHART_FOCUS_HEARTBEAT_MS);
        },
        () => {
          // Focus is an optimization; retry a transient join while this chart is
          // still selected, without surfacing its failure through React.
          scheduleRetry();
        },
      );
    open();

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
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
  }, [active, extended, symbol, timeframe, visible]);
}
