import packageMetadata from "../../../package.json";
import path from "node:path";
import {
  authorizeInstallRequest,
  checkForUpdate,
  createInstallToken,
  installPortableUpdate,
  UpdaterError,
  type DistributionMode,
  type UpdateCheck,
} from "@/app/lib/updater.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const INSTALL_TOKEN = createInstallToken();

function runtimeInfo() {
  const requestedMode = process.env.MQ_WATCHER_DISTRIBUTION_MODE;
  const mode: DistributionMode = requestedMode === "portable" || requestedMode === "npm" ? requestedMode : "source";
  return {
    mode,
    version: process.env.MQ_WATCHER_VERSION || packageMetadata.version,
    executable: mode === "portable" ? process.env.MQ_WATCHER_EXECUTABLE_PATH || process.execPath : null,
  };
}

function publicCheck(update: UpdateCheck) {
  return {
    status: update.status,
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    releaseUrl: update.releaseUrl,
    publishedAt: update.publishedAt,
    mode: update.mode,
    canInstall: update.canInstall,
    reason: update.reason ?? null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function safeError(error: unknown) {
  if (error instanceof UpdaterError) return { code: error.code, message: error.message };
  if (error instanceof DOMException && error.name === "AbortError") return { code: "cancelled", message: "The update was cancelled." };
  return { code: "update-failed", message: "MQ Watcher could not complete the update request." };
}

export async function GET(request: Request) {
  try {
    const runtime = runtimeInfo();
    const update = await checkForUpdate({
      currentVersion: runtime.version,
      mode: runtime.mode,
      signal: request.signal,
    });
    return json({ ...publicCheck(update), installToken: INSTALL_TOKEN, executableName: runtime.executable ? path.basename(runtime.executable) : null });
  } catch (error) {
    return json({ status: "error", error: safeError(error) }, 502);
  }
}

export async function POST(request: Request) {
  if (!authorizeInstallRequest(request, INSTALL_TOKEN)) return json({ status: "error", error: { code: "forbidden", message: "Cross-site or unauthorized update requests are not allowed." } }, 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return json({ status: "error", error: { code: "invalid-request", message: "Expected an application/json request." } }, 415);
  }
  try {
    const text = await request.text();
    if (text.length > 256) return json({ status: "error", error: { code: "invalid-request", message: "The update request is too large." } }, 413);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || body.action !== "install" || Object.keys(body).length !== 1) {
      return json({ status: "error", error: { code: "invalid-request", message: "Only the install action is accepted." } }, 400);
    }
    const runtime = runtimeInfo();
    if (runtime.mode !== "portable" || !runtime.executable) {
      return json({ status: "manual", releaseUrl: "https://github.com/kutaelee/mq-watcher/releases/latest" }, 409);
    }
    const update = await checkForUpdate({
      currentVersion: runtime.version,
      mode: runtime.mode,
      signal: request.signal,
    });
    if (!update.canInstall) return json({ ...publicCheck(update), status: "manual" }, 409);
    const result = await installPortableUpdate({
      update,
      currentExecutable: runtime.executable,
      signal: request.signal,
    });
    return json({ ...result, executableName: path.basename(runtime.executable) }, 202);
  } catch (error) {
    const safe = safeError(error);
    return json({ status: safe.code === "cancelled" ? "cancelled" : "error", error: safe }, safe.code === "cancelled" ? 408 : 502);
  }
}
