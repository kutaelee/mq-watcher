type UpgradeDatabase = Pick<IDBDatabase, "objectStoreNames" | "createObjectStore">;
type UpgradeTransaction = Pick<IDBTransaction, "objectStore">;

export const CACHE_SCHEMA_VERSION: number;
export function planDatabaseMigration(oldVersion: number): {
  readonly from: number;
  readonly to: number;
  readonly invalidateScanResults: boolean;
  readonly invalidateWorkbenchState: boolean;
  readonly preserveIncidentCases: true;
};
export function applyDatabaseUpgrade(db: UpgradeDatabase, transaction: UpgradeTransaction | null, oldVersion: number): void;
export function enqueueScanCacheWrite(
  signature: string,
  generation: string,
  isCurrent: (signature: string, generation: string) => boolean,
  write: () => Promise<void>,
): Promise<boolean>;
