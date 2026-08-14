export type DistributionMode = "source" | "npm" | "portable";
export type UpdateStatus = "up-to-date" | "update-available" | "blocked-draft" | "blocked-prerelease" | "blocked-downgrade";

export class UpdaterError extends Error {
  code: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  digest: string | null;
}

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  tagName: string;
  releaseUrl: string;
  mode: DistributionMode;
  publishedAt: string | null;
  status: UpdateStatus;
  canInstall: boolean;
  reason?: string | null;
  release: null | { portableAsset: ReleaseAsset; checksumAsset: ReleaseAsset };
}

export const RELEASE_API_URL: string;
export const RELEASE_PAGE_PREFIX: string;
export function createInstallToken(): string;
export function authorizeInstallRequest(request: Request, expectedToken: string): boolean;
export function parseSemver(value: string): { raw: string; major: bigint; minor: bigint; patch: bigint; prerelease: string[] };
export function compareSemver(left: string, right: string): number;
export function checkForUpdate(options: {
  currentVersion: string;
  mode?: DistributionMode;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<UpdateCheck>;
export function stagePortableUpdate(options: {
  update: UpdateCheck;
  currentExecutable: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  randomBytesImpl?: (size: number) => Buffer;
}): Promise<{ stagedPath: string; currentExecutable: string; expectedSha256: string; version: string }>;
export function launchPortableReplacement(options: {
  stagedPath: string;
  currentExecutable: string;
  expectedSha256: string;
  version: string;
  platform?: NodeJS.Platform;
  processId?: number;
  spawnImpl?: typeof import("node:child_process").spawn;
  scheduleExit?: () => void;
}): Promise<{ status: "restarting"; version: string }>;
export function installPortableUpdate(options: Parameters<typeof stagePortableUpdate>[0] & { replacement?: Partial<Parameters<typeof launchPortableReplacement>[0]> }): Promise<{ status: "restarting"; version: string }>;
