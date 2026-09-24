import type { BarsResponse } from '@/shared/api/market';

const DATABASE = 'edicius-market-bars';
const STORE = 'series';
const VERSION = 1;
const DEFAULT_LIMIT = 48;

type SavedSeries = {
  version: number;
  ownerId: string;
  key: string;
  savedAt: number;
  response: BarsResponse;
};

export type BarCacheStorage = {
  read: (key: string) => Promise<unknown>;
  write: (key: string, value: SavedSeries) => Promise<void>;
  oldestKeys: () => Promise<string[]>;
  remove: (key: string) => Promise<void>;
  clear: () => Promise<void>;
};

function seriesKey(ownerId: string, symbol: string, timeframe: string, extended: boolean): string {
  return JSON.stringify([ownerId, symbol, timeframe, extended]);
}

function validResponse(value: unknown): value is BarsResponse {
  if (value === null || typeof value !== 'object') return false;
  const response = value as Partial<BarsResponse>;
  return (
    typeof response.symbol === 'string' &&
    typeof response.timeframe === 'string' &&
    typeof response.provider === 'string' &&
    typeof response.extended === 'boolean' &&
    typeof response.hasSession === 'boolean' &&
    typeof response.stale === 'boolean' &&
    (response.capturedAt === undefined ||
      (typeof response.capturedAt === 'number' && Number.isFinite(response.capturedAt))) &&
    Array.isArray(response.bars) &&
    response.bars.every(
      (bar) =>
        bar !== null &&
        typeof bar === 'object' &&
        [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(
          (number) => typeof number === 'number' && Number.isFinite(number),
        ),
    )
  );
}

export function createMarketBarCache(
  storage: BarCacheStorage,
  { limit = DEFAULT_LIMIT, now = Date.now }: { limit?: number; now?: () => number } = {},
) {
  let mutation = Promise.resolve();
  function queueMutation(operation: () => Promise<void>): Promise<void> {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => undefined);
    return next;
  }

  return {
    async read(ownerId: string, symbol: string, timeframe: string, extended: boolean) {
      if (!ownerId) return null;
      const key = seriesKey(ownerId, symbol, timeframe, extended);
      try {
        const value = await storage.read(key);
        if (value === null || typeof value !== 'object') return null;
        const saved = value as Partial<SavedSeries>;
        if (
          saved.version !== VERSION ||
          saved.ownerId !== ownerId ||
          saved.key !== key ||
          !Number.isFinite(saved.savedAt) ||
          !validResponse(saved.response) ||
          saved.response.symbol !== symbol ||
          saved.response.timeframe !== timeframe ||
          saved.response.extended !== extended
        )
          return null;
        return {
          ...saved.response,
          capturedAt: saved.response.capturedAt ?? saved.savedAt,
          stale: true,
        };
      } catch {
        return null;
      }
    },
    write(ownerId: string, response: BarsResponse) {
      if (!ownerId || !validResponse(response)) return;
      const key = seriesKey(ownerId, response.symbol, response.timeframe, response.extended);
      return queueMutation(async () => {
        try {
          await storage.write(key, { version: VERSION, ownerId, key, savedAt: now(), response });
          const keys = await storage.oldestKeys();
          for (const old of keys.slice(0, Math.max(0, keys.length - limit))) {
            await storage.remove(old);
          }
        } catch {
          // Private mode, disabled storage and quota errors only lose the local copy.
        }
      });
    },
    clear() {
      return queueMutation(async () => {
        try {
          await storage.clear();
        } catch {
          // Authentication and network state are independent of browser storage.
        }
      });
    },
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE).createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, resolve: (value: T) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    let result: T;
    operation(transaction.objectStore(STORE), (value) => {
      result = value;
    });
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

const indexedDbStorage: BarCacheStorage = {
  read: (key) =>
    transact('readonly', (store, finish) => {
      const request = store.get(key);
      request.onsuccess = () => finish(request.result ?? null);
    }),
  write: (key, value) =>
    transact('readwrite', (store, finish) => {
      store.put(value, key);
      finish(undefined);
    }),
  oldestKeys: () =>
    transact('readonly', (store, finish) => {
      const keys: string[] = [];
      const request = store.index('savedAt').openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (typeof cursor.primaryKey === 'string') keys.push(cursor.primaryKey);
          cursor.continue();
        } else finish(keys);
      };
    }),
  remove: (key) =>
    transact('readwrite', (store, finish) => {
      store.delete(key);
      finish(undefined);
    }),
  clear: () =>
    transact('readwrite', (store, finish) => {
      store.clear();
      finish(undefined);
    }),
};

export const marketBarCache = createMarketBarCache(indexedDbStorage);
