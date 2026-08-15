export type UpdatedServerStatus = {
  status: string;
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  mode?: "source" | "npm" | "portable";
  canInstall?: boolean;
  installToken?: string;
  reason?: string | null;
};

export function waitForUpdatedServer(options: {
  targetVersion: string;
  fetchStatus: (signal?: AbortSignal) => Promise<UpdatedServerStatus>;
  signal?: AbortSignal;
  attempts?: number;
  intervalMs?: number;
  delay?: (delayMs: number, signal?: AbortSignal) => Promise<unknown>;
}): Promise<UpdatedServerStatus | null>;
