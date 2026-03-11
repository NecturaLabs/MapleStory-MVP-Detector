/**
 * dbService.ts
 * IndexedDB wrapper for chat message history.
 * Database: "msmvp", Object store: "messages"
 */

const DB_NAME = 'msmvp';
const STORE = 'messages';
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

export interface DbMessage {
  id?: number;
  capturedAt: number;
  text: string;
  isMvpMatch: boolean;
  isNewMvp: boolean;
  details: MvpDetails | null;
  source?: 'tesseract' | 'onnx';
}

export interface MvpDetails {
  channel: number | null;
  willBeUsedAt: number | null; // stored as timestamp ms
  location: LocationMatch | null;
  rawTimestamp: string | null;
  dedupKey: string | null;
}

export interface LocationMatch {
  mapName: string;
  matchedKeyword: string;
}

/**
 * Open (or create) the IndexedDB database.
 */
export function openDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const database = (e.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('capturedAt', 'capturedAt', { unique: false });
      }
    };

    req.onsuccess = (e) => {
      db = (e.target as IDBOpenDBRequest).result;
      resolve(db);
    };

    req.onerror = (e) => {
      reject((e.target as IDBOpenDBRequest).error);
    };
  });
}

/**
 * Insert a single message record.
 */
export async function insertMessage(msg: DbMessage): Promise<number> {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.add(msg);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/**
 * Load the most recent N messages in ascending order.
 */
export async function loadRecentMessages(n: number): Promise<DbMessage[]> {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = (req.result as DbMessage[]) || [];
      resolve(all.slice(-n));
    };
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/**
 * Keep only the most recent N records, delete older ones.
 */
export async function trimToMax(n: number): Promise<void> {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const countReq = store.count();

    countReq.onsuccess = () => {
      const total = countReq.result;
      if (total <= n) { resolve(); return; }

      const excess = total - n;
      let deleted = 0;
      const cursor = store.openCursor();

      cursor.onsuccess = (e) => {
        const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!c || deleted >= excess) { resolve(); return; }
        c.delete();
        deleted++;
        c.continue();
      };
      cursor.onerror = (e) => reject((e.target as IDBRequest).error);
    };
    countReq.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/**
 * Delete all records from the messages store.
 */
export async function clearAll(): Promise<void> {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/**
 * Update specific fields of an existing message record.
 */
export async function updateMessage(id: number, patch: Partial<Pick<DbMessage, 'source' | 'text' | 'isMvpMatch' | 'isNewMvp'>>): Promise<void> {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as DbMessage | undefined;
      if (!existing) { resolve(); return; }
      const updated = { ...existing, ...patch };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve();
      putReq.onerror = (e) => reject((e.target as IDBRequest).error);
    };
    getReq.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

/**
 * Get total message count.
 */
export async function getCount(): Promise<number> {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}
