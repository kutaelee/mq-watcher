function wait(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForUpdatedServer({
  targetVersion,
  fetchStatus,
  signal,
  attempts = 40,
  intervalMs = 750,
  delay = wait,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const status = await fetchStatus(signal);
      if (status?.currentVersion === targetVersion) return status;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (attempt < attempts - 1) await delay(intervalMs, signal);
  }
  return null;
}
