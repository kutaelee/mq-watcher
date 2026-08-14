import type { IncidentCase, ScanResult } from "./types";

const DB_NAME = "mq-watcher";
const STORE_NAME = "scan-results";
const WORKBENCH_STORE = "workbench-state";
const CASE_STORE = "incident-cases";
const META_STORE = "schema-meta";
export const CACHE_SCHEMA_VERSION = 4;
const DB_VERSION = CACHE_SCHEMA_VERSION;

type UpgradeDatabase = Pick<IDBDatabase, "objectStoreNames" | "createObjectStore">;
type UpgradeTransaction = Pick<IDBTransaction, "objectStore">;

export function planDatabaseMigration(oldVersion: number) {
  return {
    from: oldVersion,
    to: CACHE_SCHEMA_VERSION,
    invalidateScanResults: oldVersion > 0 && oldVersion < CACHE_SCHEMA_VERSION,
    invalidateWorkbenchState: oldVersion > 0 && oldVersion < CACHE_SCHEMA_VERSION,
    preserveIncidentCases: true,
  } as const;
}

export function applyDatabaseUpgrade(
  db: UpgradeDatabase,
  transaction: UpgradeTransaction | null,
  oldVersion: number,
): void {
  const existing = new Set(Array.from(db.objectStoreNames));
  if (!existing.has(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "signature" });
  if (!existing.has(WORKBENCH_STORE)) db.createObjectStore(WORKBENCH_STORE, { keyPath: "id" });
  if (!existing.has(CASE_STORE)) db.createObjectStore(CASE_STORE, { keyPath: "id" });
  if (!existing.has(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });

  const plan = planDatabaseMigration(oldVersion);
  if (transaction && plan.invalidateScanResults && existing.has(STORE_NAME)) {
    transaction.objectStore(STORE_NAME).clear();
  }
  if (transaction && plan.invalidateWorkbenchState && existing.has(WORKBENCH_STORE)) {
    transaction.objectStore(WORKBENCH_STORE).clear();
  }
  transaction?.objectStore(META_STORE).put({ id: "schema", version: CACHE_SCHEMA_VERSION });
}

const cacheWriteQueues = new Map<string, Promise<void>>();

export async function enqueueScanCacheWrite(
  signature: string,
  generation: string,
  isCurrent: (signature: string, generation: string) => boolean,
  write: () => Promise<void>,
): Promise<boolean> {
  const previous = cacheWriteQueues.get(signature) ?? Promise.resolve();
  let applied = false;
  const queued = previous.catch(() => undefined).then(async () => {
    if (!isCurrent(signature, generation)) return;
    await write();
    applied = true;
  });
  cacheWriteQueues.set(signature, queued);
  try {
    await queued;
    return applied;
  } finally {
    if (cacheWriteQueues.get(signature) === queued) cacheWriteQueues.delete(signature);
  }
}

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
