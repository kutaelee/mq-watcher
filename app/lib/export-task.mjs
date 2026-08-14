function detachAndTerminate(worker) {
  if (!worker) return;
  worker.onmessage = null;
  worker.onerror = null;
  worker.terminate();
}

export class ExportTaskLifecycle {
  constructor({ clearTimer = (value) => clearTimeout(value), setTimer = (callback, delay) => setTimeout(callback, delay), revokeUrl = (value) => URL.revokeObjectURL(value) } = {}) {
    this.clearTimer = clearTimer;
    this.setTimer = setTimer;
    this.revokeUrl = revokeUrl;
    this.operationId = 0;
    this.worker = null;
    this.timer = null;
    this.objectUrl = null;
    this.mounted = true;
  }

  begin() {
    this.operationId += 1;
    this.cleanupWorker();
    this.cleanupDownload();
    return this.operationId;
  }

  activate() {
    this.mounted = true;
  }

  attachWorker(operationId, worker) {
    if (!this.isCurrent(operationId)) {
      detachAndTerminate(worker);
      return false;
    }
    this.worker = worker;
    return true;
  }

  isCurrent(operationId) {
    return this.mounted && operationId === this.operationId;
  }

  releaseWorker(worker) {
    if (this.worker === worker) this.worker = null;
    detachAndTerminate(worker);
  }

  cancel() {
    const cancelledOperation = this.operationId;
    const worker = this.worker;
    this.operationId += 1;
    this.worker = null;
    if (worker) {
      try {
        worker.postMessage({ type: "cancel", operationId: cancelledOperation });
      } finally {
        detachAndTerminate(worker);
      }
    }
    this.cleanupDownload();
    return cancelledOperation;
  }

  trackObjectUrl(operationId, url, delay = 1000) {
    if (!this.isCurrent(operationId)) {
      this.revokeUrl(url);
      return false;
    }
    this.cleanupDownload();
    this.objectUrl = url;
    this.timer = this.setTimer(() => {
      if (this.objectUrl === url) {
        this.revokeUrl(url);
        this.objectUrl = null;
      }
      this.timer = null;
    }, delay);
    return true;
  }

  cleanupWorker() {
    const worker = this.worker;
    this.worker = null;
    detachAndTerminate(worker);
  }

  cleanupDownload() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.objectUrl !== null) this.revokeUrl(this.objectUrl);
    this.objectUrl = null;
  }

  dispose() {
    this.mounted = false;
    this.operationId += 1;
    this.cleanupWorker();
    this.cleanupDownload();
  }
}

export function createAndClickDownload({ blob, filename, createObjectUrl, revokeObjectUrl, click }) {
  let url = null;
  try {
    url = createObjectUrl(blob);
    click(url, filename);
    return url;
  } catch (error) {
    if (url !== null) revokeObjectUrl(url);
    throw error;
  }
}
