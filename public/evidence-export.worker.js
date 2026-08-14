import { buildEvidenceBundle } from "./workbench-export.js";

const cancelled = new Set();

self.onmessage = async (event) => {
  const { type, operationId, payload } = event.data ?? {};
  if (type === "cancel") { cancelled.add(operationId); return; }
  if (type !== "build") return;
  cancelled.delete(operationId);
  try {
    const result = await buildEvidenceBundle(payload, {
      isCancelled: () => cancelled.has(operationId),
      onProgress: (progress) => self.postMessage({ type: "progress", operationId, ...progress }),
    });
    if (!cancelled.has(operationId)) self.postMessage({ type: "complete", operationId, result }, [result.bytes.buffer]);
  } catch (error) {
    if (error?.name === "AbortError" || cancelled.has(operationId)) self.postMessage({ type: "cancelled", operationId });
    else self.postMessage({ type: "error", operationId, message: error instanceof Error ? error.message : String(error) });
  } finally { cancelled.delete(operationId); }
};
