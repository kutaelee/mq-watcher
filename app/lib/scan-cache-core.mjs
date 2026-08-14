const STORE_NAME = "scan-results";
const WORKBENCH_STORE = "workbench-state";
const CASE_STORE = "incident-cases";
const META_STORE = "schema-meta";

export const CACHE_SCHEMA_VERSION = 4;

export function planDatabaseMigration(oldVersion) {
  return {
    from: oldVersion,
    to: CACHE_SCHEMA_VERSION,
    invalidateScanResults: oldVersion > 0 && oldVersion < CACHE_SCHEMA_VERSION,
    invalidateWorkbenchState: oldVersion > 0 && oldVersion < CACHE_SCHEMA_VERSION,
    preserveIncidentCases: true,
  };
}

export function applyDatabaseUpgrade(db, transaction, oldVersion) {
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

const cacheWriteQueues = new Map();

export async function enqueueScanCacheWrite(signature, generation, isCurrent, write) {
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
