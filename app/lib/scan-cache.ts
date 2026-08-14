import type { IncidentCase, ScanResult } from "./types";
import {
  applyDatabaseUpgrade,
  CACHE_SCHEMA_VERSION,
} from "./scan-cache-core.mjs";

export {
  applyDatabaseUpgrade,
  CACHE_SCHEMA_VERSION,
  enqueueScanCacheWrite,
  planDatabaseMigration,
} from "./scan-cache-core.mjs";

const DB_NAME = "mq-watcher";
const STORE_NAME = "scan-results";
const WORKBENCH_STORE = "workbench-state";
const CASE_STORE = "incident-cases";
const DB_VERSION = CACHE_SCHEMA_VERSION;

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
    request.onupgradeneeded = (event) => applyDatabaseUpgrade(request.result, request.transaction, event.oldVersion);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readIncidentCases(): Promise<IncidentCase[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CASE_STORE, "readonly");
    const request = tx.objectStore(CASE_STORE).getAll();
    request.onsuccess = () => resolve((request.result as IncidentCase[]).map((incident) => ({
      ...incident,
      pins: (incident.pins ?? []).map((pin) => ({
        ...pin,
        semanticKey: pin.semanticKey ?? `legacy:${pin.id}`,
        provenance: pin.provenance ?? { file: (pin as unknown as { file?: string }).file ?? "", offset: (pin as unknown as { offset?: number | null }).offset ?? null },
      })),
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeIncidentCase(value: IncidentCase): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CASE_STORE, "readwrite");
    tx.objectStore(CASE_STORE).put(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
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
