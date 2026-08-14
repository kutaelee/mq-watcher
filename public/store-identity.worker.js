import { buildContentStoreSignature } from "./store-identity.js";

let active = null;

self.onmessage = async (event) => {
  if (event.data?.type === "cancel") {
    if (!active || event.data.requestId === active.requestId) active?.controller.abort();
    return;
  }
  if (event.data?.type !== "identify") return;

  active?.controller.abort();
  const controller = new AbortController();
  const requestId = event.data.requestId;
  active = { requestId, controller };
  try {
    const signature = await buildContentStoreSignature(event.data.files, event.data.scannerVersion, {
      signal: controller.signal,
      onProgress: event.data.reportProgress
        ? (progress) => self.postMessage({ type: "progress", requestId, ...progress })
        : undefined,
    });
    if (active?.requestId === requestId && !controller.signal.aborted) {
      self.postMessage({ type: "complete", requestId, signature });
    }
  } catch (error) {
    if (active?.requestId !== requestId) return;
    if (controller.signal.aborted || error?.name === "AbortError") self.postMessage({ type: "cancelled", requestId });
    else self.postMessage({ type: "error", requestId, message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (active?.requestId === requestId) active = null;
  }
};
