"use client";

import { Download, ExternalLink, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/app/lib/i18n";
import { waitForUpdatedServer } from "@/app/lib/update-reconnect.mjs";

type UpdateState = {
  status: "checking" | "up-to-date" | "update-available" | "blocked-draft" | "blocked-prerelease" | "blocked-downgrade" | "manual" | "restarting" | "completed" | "restart-required" | "error";
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  mode?: "source" | "npm" | "portable";
  canInstall?: boolean;
  installToken?: string;
  reason?: string | null;
  error?: { code?: string; message?: string };
  version?: string;
  executableName?: string | null;
};

const copy = {
  ko: {
    title: "업데이트",
    checking: "최신 릴리스 확인 중",
    current: "현재 {current} · 최신 {latest}",
    available: "새 버전 {latest}을 사용할 수 있습니다.",
    currentOk: "최신 버전을 사용 중입니다.",
    manual: "이 설치 방식은 릴리스 페이지에서 수동 업데이트합니다.",
    blocked: "시험판 또는 이전 버전은 설치하지 않습니다.",
    failed: "업데이트 정보를 확인하지 못했습니다.",
    check: "다시 확인",
    install: "검증·교체 후 자동 재시작",
    cancel: "취소",
    release: "릴리스 열기",
    installing: "다운로드·SHA-256 검증 중",
    replaceNote: "Windows portable 업데이트는 현재 실행한 {executable}를 같은 위치에서 교체합니다. 새 EXE 파일은 따로 만들지 않으며, 교체 후 같은 파일을 자동으로 다시 엽니다.",
    restarting: "검증을 마쳤습니다. 현재 {executable}를 같은 위치에서 교체하고 자동 재실행한 뒤 연결을 확인하고 있습니다.",
    completed: "업데이트와 자동 재실행을 확인했습니다. 잠시 후 새 버전 화면을 다시 불러옵니다.",
    restartRequired: "자동 재연결을 확인하지 못했습니다. 처음 실행했던 같은 {executable}를 다시 실행해 주세요. 별도의 새 EXE를 찾을 필요는 없습니다.",
    privacy: "저장소 경로·이름·분석 결과는 전송하지 않습니다.",
  },
  en: {
    title: "Updates",
    checking: "Checking the latest release",
    current: "Current {current} · latest {latest}",
    available: "MQ Watcher {latest} is available.",
    currentOk: "You are running the latest release.",
    manual: "This distribution updates manually from the release page.",
    blocked: "Pre-release and downgrade installs are blocked.",
    failed: "Update information could not be checked.",
    check: "Check again",
    install: "Verify, replace, and restart",
    cancel: "Cancel",
    release: "Open release",
    installing: "Downloading and verifying SHA-256",
    replaceNote: "A Windows portable update replaces the {executable} you launched in the same folder. It does not create a second EXE, and it automatically opens that same filename after replacement.",
    restarting: "Verification finished. Replacing the current {executable} in place, restarting it, and checking the connection.",
    completed: "The update and automatic restart were verified. Reloading the new version shortly.",
    restartRequired: "The automatic reconnect could not be verified. Run the same {executable} you originally launched; there is no separate new EXE to find.",
    privacy: "Store paths, names, and analysis results are never sent.",
  },
} as const;

function withValues(value: string, state: UpdateState) {
  return value
    .replace("{current}", state.currentVersion || "?")
    .replace("{latest}", state.latestVersion || "?")
    .replace("{executable}", state.executableName || "mq-watcher.exe");
}

export function UpdatePanel({ locale }: { locale: Locale }) {
  const labels = copy[locale];
  const [state, setState] = useState<UpdateState>({ status: "checking" });
  const [installing, setInstalling] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const reloadTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const check = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ status: "checking" });
    try {
      const response = await fetch("/api/update", { method: "GET", cache: "no-store", signal: controller.signal });
      const body = await response.json() as UpdateState;
      if (!response.ok) throw new Error(body.error?.message || "Update check failed");
      setState(body);
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ status: "error", error: { message: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void check();
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
    };
  }, [check]);

  const install = async () => {
    const controller = new AbortController();
    requestRef.current = controller;
    setInstalling(true);
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MQ-Watcher-Install-Token": state.installToken || "",
        },
        body: JSON.stringify({ action: "install" }),
        signal: controller.signal,
      });
      const body = await response.json() as UpdateState;
      if (!response.ok) throw new Error(body.error?.message || "Update install failed");
      const targetVersion = body.version || state.latestVersion;
      setState((current) => ({ ...current, ...body, status: "restarting" }));
      setInstalling(false);
      if (!targetVersion) return;
      const updated = await waitForUpdatedServer({
        targetVersion,
        signal: controller.signal,
        fetchStatus: async (signal?: AbortSignal) => {
          const statusResponse = await fetch("/api/update", { method: "GET", cache: "no-store", signal });
          if (!statusResponse.ok) throw new Error("Update reconnect check failed");
          return await statusResponse.json() as UpdateState;
        },
      });
      if (!updated) {
        setState((current) => ({ ...current, status: "restart-required" }));
        return;
      }
      setState((current) => ({ ...current, ...updated, status: "completed" }));
      reloadTimerRef.current = window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      if (!mountedRef.current) return;
      if (controller.signal.aborted) setState((current) => ({ ...current, status: "update-available" }));
      else setState((current) => ({ ...current, status: "error", error: { message: error instanceof Error ? error.message : String(error) } }));
    } finally {
      if (mountedRef.current) setInstalling(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  let message: string = labels.checking;
  if (state.status === "up-to-date") message = labels.currentOk;
  if (state.status === "update-available") message = state.canInstall ? withValues(labels.available, state) : labels.manual;
  if (["blocked-draft", "blocked-prerelease", "blocked-downgrade"].includes(state.status)) message = labels.blocked;
  if (state.status === "manual") message = labels.manual;
  if (state.status === "restarting") message = withValues(labels.restarting, state);
  if (state.status === "completed") message = labels.completed;
  if (state.status === "restart-required") message = withValues(labels.restartRequired, state);
  if (state.status === "error") message = labels.failed;

  return (
    <section className="update-panel" aria-live="polite">
      <div className="update-panel-title"><RefreshCw size={14} /><strong>{labels.title}</strong></div>
      <p>{installing ? labels.installing : message}</p>
      {state.status === "update-available" && state.canInstall ? <small className="update-replace-note">{withValues(labels.replaceNote, state)}</small> : null}
      {state.currentVersion && state.latestVersion ? <small>{withValues(labels.current, state)}</small> : null}
      <div className="update-panel-actions">
        {state.status === "checking" ? <LoaderCircle className="spin" size={15} /> : null}
        {state.status === "update-available" && state.canInstall && state.installToken && !installing ? <button onClick={install}><Download size={13} />{labels.install}</button> : null}
        {installing ? <button onClick={() => requestRef.current?.abort()}><X size={13} />{labels.cancel}</button> : null}
        {state.releaseUrl ? <a href={state.releaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{labels.release}</a> : null}
        {state.status === "error" || state.status === "restart-required" ? <button onClick={check}><RefreshCw size={13} />{labels.check}</button> : null}
      </div>
      <small className="update-privacy">{labels.privacy}</small>
    </section>
  );
}
