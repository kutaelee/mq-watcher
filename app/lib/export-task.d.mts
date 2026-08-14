export type ExportWorkerLike = {
  onmessage: unknown;
  onerror: unknown;
  postMessage(message: unknown): void;
  terminate(): void;
};

export class ExportTaskLifecycle {
  constructor(options?: {
    clearTimer?: (value: unknown) => void;
    setTimer?: (callback: () => void, delay: number) => unknown;
    revokeUrl?: (value: string) => void;
  });
  operationId: number;
  mounted: boolean;
  activate(): void;
  begin(): number;
  attachWorker(operationId: number, worker: ExportWorkerLike): boolean;
  isCurrent(operationId: number): boolean;
  releaseWorker(worker: ExportWorkerLike): void;
  cancel(): number;
  trackObjectUrl(operationId: number, url: string, delay?: number): boolean;
  cleanupWorker(): void;
  cleanupDownload(): void;
  dispose(): void;
}

export function createAndClickDownload(options: {
  blob: Blob;
  filename: string;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  click: (url: string, filename: string) => void;
}): string;
