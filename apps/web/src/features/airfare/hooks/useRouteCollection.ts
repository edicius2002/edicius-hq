import { useCallback, useState } from 'react';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { CollectNotice } from '@/features/airfare/lib/collectNotice';
import type { PassProgress } from '@/features/airfare/lib/passProgress';
import type { RowReport } from '@/features/airfare/lib/rowReport';

export type RouteCollection = {
  collecting: readonly string[];
  reports: ReadonlyMap<string, RowReport>;
  progress: ReadonlyMap<string, PassProgress>;
  notices: readonly CollectNotice[];
  collect: (route: FareRoute, month: string) => void;
  forget: (id: string) => void;
};

/** Manual route collection is retired; the Pi timer is the collection authority. */
export function useRouteCollection(): RouteCollection {
  const [reports, setReports] = useState<ReadonlyMap<string, RowReport>>(() => new Map());
  const forget = useCallback((id: string) => {
    setReports((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  return { collecting: [], reports, progress: new Map(), notices: [], collect: () => {}, forget };
}
