import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { useRegime } from '@/features/investing/chart/useCandles';
import { activeAlertSymbols } from '@/features/investing/data/priceAlerts';
import { PRIORITY, quoteBus } from '@/features/investing/data/quoteBus';
import { usePriceAlerts } from '@/features/investing/hooks/usePriceAlerts';
import { alertSoundPlayer, armOnFirstGesture } from '@/features/investing/lib/alertSound';
import {
  evaluateAlert,
  isRegularSessionQuote,
  seedFromPreviousClose,
  type TrackedAlert,
} from '@/features/investing/lib/alertCross';
import { cadenceFor } from '@/features/investing/lib/session';
import { formatAmount } from '@/shared/lib/money';
import { toastBus } from '@/shared/ui/toastBus';

/**
 * Watches every active price alert, regardless of which page is open.
 *
 * Mounted once, above the router (`App.tsx`) rather than inside
 * `InvestingPage` — leaving Investing must not lose the crossing state an
 * alert has already armed, nor silence a rule the user asked to be told
 * about. It owns its own quote subscription rather than reusing
 * InvestingPage's `wanted` set: the symbols it needs quotes for are exactly
 * the symbols carrying an active alert, which need not be the watchlist, the
 * portfolio, or whatever is charted. It still goes through `quoteBus` — the
 * same module-level singleton InvestingPage's own quote query uses — so a
 * symbol both alerted on and displayed shares one cached/in-flight request
 * rather than doubling it.
 */
export function PriceAlertsWatcher() {
  const { rules, alerts, trigger } = usePriceAlerts();
  const regime = useRegime();

  const symbols = useMemo(() => activeAlertSymbols(rules), [rules]);
  const key = symbols.join(',');

  const query = useQuery({
    queryKey: ['market', 'alert-quotes', key],
    queryFn: () => quoteBus.quotes(symbols, { priority: PRIORITY.watchlist }),
    enabled: symbols.length > 0,
    refetchInterval: cadenceFor(regime, 0).quotesMs,
  });

  useEffect(() => armOnFirstGesture(alertSoundPlayer), []);

  // Tracked side per alert id. Deliberately a ref, not state: it is read and
  // written only inside the effect below, and putting it in state would
  // trigger a render this component has nothing to show for.
  const tracked = useRef(new Map<string, TrackedAlert>());

  useEffect(() => {
    const quotes = query.data?.quotes;
    if (!quotes) return;

    const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));

    for (const alert of alerts) {
      if (!alert.active) {
        tracked.current.delete(alert.id);
        continue;
      }

      const quote = bySymbol.get(alert.symbol);
      if (!quote || !Number.isFinite(quote.price)) continue;

      // A never-tracked alert is seeded from the last known *regular*-session
      // price (`previousClose`) rather than from whatever quote happens to
      // arrive first — see `seedFromPreviousClose`. Computed once and kept:
      // once tracked, this branch never runs for this alert again.
      const previous =
        tracked.current.get(alert.id) ?? seedFromPreviousClose(alert, quote.previousClose);

      // Extended-hours and closed-market prints are skipped entirely, not
      // merely excluded from firing: they are never fed into `evaluateAlert`
      // at all, so the tracked side stays whatever the last *regular*-session
      // price left it at. That is what makes a crossing that happens
      // overnight wait for the open instead of firing on a pre-market print
      // — `marketState` is what says whether this quote came from the
      // regular session (see `lib/alertCross.ts`'s `isRegularSessionQuote`
      // and `lib/session.ts`). The seed above still lands even on a
      // non-regular print, so the next regular one has something honest to
      // evaluate against instead of starting from nothing.
      if (!isRegularSessionQuote(quote)) {
        if (previous) tracked.current.set(alert.id, previous);
        continue;
      }

      const { fired, next } = evaluateAlert(alert, quote.price, previous);

      if (fired) {
        tracked.current.delete(alert.id);
        void trigger(alert.id);
        const verb = alert.kind === 'buy' ? 'Buy' : 'Sell';
        toastBus.push({
          message: `${verb} ${alert.symbol} at ${formatAmount(alert.price)} — now ${formatAmount(quote.price)}`,
          tone: alert.kind,
        });
        alertSoundPlayer.play(alert.kind);
      } else {
        tracked.current.set(alert.id, next);
      }
    }
  }, [query.data, alerts, trigger]);

  return null;
}
