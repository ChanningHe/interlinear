import type { Cache } from "./translate";

// Translations live only in this browser profile's IndexedDB. Nothing is uploaded.

interface Entry {
  readonly key: string;
  readonly value: string;
  /** Epoch milliseconds when the entry was written. */
  readonly time: number;
}

export interface IdbCacheOptions {
  readonly dbName?: string;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

const STORE = "translations";
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export function createIdbCache(opts: IdbCacheOptions = {}): Cache & { prune(): Promise<void>; clear(): Promise<void> } {
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  let db: Promise<IDBDatabase> | undefined;

  const open = () => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(opts.dbName ?? "interlinear", 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" }).createIndex("time", "time");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      db = undefined; // allow a later retry
      throw e;
    });
    return db;
  };

  return {
    async get(keys) {
      const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
      const oldest = now() - maxAge;
      const rows = await Promise.all(keys.map((k) => done<Entry | undefined>(store.get(k))));
      return rows.map((r) => (r && r.time >= oldest ? r.value : undefined));
    },
    async set(entries) {
      const tx = (await open()).transaction(STORE, "readwrite");
      const time = now();
      for (const [key, value] of entries) tx.objectStore(STORE).put({ key, value, time } satisfies Entry);
      await committed(tx);
    },
    async prune() {
      const tx = (await open()).transaction(STORE, "readwrite");
      const range = IDBKeyRange.upperBound(now() - maxAge, true);
      const keys = await done(tx.objectStore(STORE).index("time").getAllKeys(range));
      for (const k of keys) tx.objectStore(STORE).delete(k);
      await committed(tx);
    },
    async clear() {
      const tx = (await open()).transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await committed(tx);
    },
  };
}
