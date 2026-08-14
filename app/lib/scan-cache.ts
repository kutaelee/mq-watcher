import type { ScanResult } from "./types";

const DB_NAME = "mq-watcher";
const STORE_NAME = "scan-results";
const WORKBENCH_STORE = "workbench-state";
const DB_VERSION = 2;

export type PersistedWorkbenchState = {
  id: "current";
  activeSessionId: string | null;
  sessions: Array<{
    id: string;
    signature: string;
    name: string;
    result: ScanResult;
    activeView: string;
    selected: unknown;
    openedAt: string;
  }>;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "signature" });
      }
      if (!db.objectStoreNames.contains(WORKBENCH_STORE)) {
        db.createObjectStore(WORKBENCH_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readWorkbenchState(): Promise<PersistedWorkbenchState | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKBENCH_STORE, "readonly");
    const request = tx.objectStore(WORKBENCH_STORE).get("current");
    request.onsuccess = () => resolve((request.result as PersistedWorkbenchState) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeWorkbenchState(state: PersistedWorkbenchState): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKBENCH_STORE, "readwrite");
    tx.objectStore(WORKBENCH_STORE).put(state);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function readScanCache(
  signature: string,
): Promise<ScanResult | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(signature);
    request.onsuccess = () => resolve((request.result as ScanResult) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeScanCache(result: ScanResult): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(result);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}
