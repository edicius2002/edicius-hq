import {
  INDICATORS_KEY,
  NO_INDICATORS,
  normalizeIndicators,
  toggle,
  type IndicatorId,
  type Indicators,
} from '@/features/investing/data/indicators';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * Which indicators are on, persisted.
 *
 * Through the same facade as everything else, so the writes are serialised and
 * refused after a failed read. The rules live in `data/indicators`; nothing
 * here decides anything.
 */
export function useIndicators() {
  const store = useStoredDocument<Indicators>({
    key: INDICATORS_KEY,
    normalize: normalizeIndicators,
    placeholder: NO_INDICATORS,
  });

  return {
    indicators: store.data,
    isError: store.isError,
    toggle: (id: IndicatorId) => store.edit((current) => toggle(current, id)),
  };
}
