import type { AnalysisResponse } from "../types";

const DB_NAME = "failure-analyzer-cache";
const STORE_NAME = "analyses";
const FALLBACK_PREFIX = "failure-analyzer:cache:";

type CachedAnalysis = {
  key: string;
  createdAt: string;
  value: AnalysisResponse;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function getCachedAnalysis(key: string): Promise<AnalysisResponse | null> {
  try {
    const db = await openDatabase();
    return await new Promise<AnalysisResponse | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        db.close();
        const result = request.result as CachedAnalysis | undefined;
        resolve(result?.value ?? null);
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error("Failed to read cache"));
      };
    });
  } catch {
    const raw = localStorage.getItem(`${FALLBACK_PREFIX}${key}`);
    return raw ? (JSON.parse(raw) as AnalysisResponse) : null;
  }
}

export async function setCachedAnalysis(key: string, value: AnalysisResponse): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put({ key, createdAt: new Date().toISOString(), value } satisfies CachedAnalysis);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error("Failed to write cache"));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error("Failed to write cache"));
      };
    });
  } catch {
    localStorage.setItem(`${FALLBACK_PREFIX}${key}`, JSON.stringify(value));
  }
}
