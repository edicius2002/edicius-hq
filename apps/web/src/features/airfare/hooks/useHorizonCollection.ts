import { useCallback, useState } from 'react';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { HorizonProgress } from '@/features/airfare/lib/horizonProgress';
import type { RowReport } from '@/features/airfare/lib/rowReport';

export type HorizonCollection = {
  collecting: readonly string[];
  reports: ReadonlyMap<string, RowReport>;
  progress: ReadonlyMap<string, HorizonProgress>;
  collect: (route: FareRoute) => void;
  forget: (id: string) => void;
};

/** Manual horizon collection is retired; the Pi timer is the collection authority. */
export function useHorizonCollection(): HorizonCollection {
  const [reports, setReports] = useState<ReadonlyMap<string, RowReport>>(() => new Map());
  const forget = useCallback((id: string) => {
    setReports((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  return { collecting: [], reports, progress: new Map(), collect: () => {}, forget };
}
