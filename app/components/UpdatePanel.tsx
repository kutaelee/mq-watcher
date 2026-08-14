"use client";

import { Download, ExternalLink, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/app/lib/i18n";

type UpdateState = {
  status: "checking" | "up-to-date" | "update-available" | "blocked-draft" | "blocked-prerelease" | "blocked-downgrade" | "manual" | "restarting" | "error";
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  mode?: "source" | "npm" | "portable";
  canInstall?: boolean;
  reason?: string | null;
  error?: { code?: string; message?: string };
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
    install: "검증 후 업데이트",
    cancel: "취소",
    release: "릴리스 열기",
    installing: "다운로드·SHA-256 검증 중",
    restarting: "검증 완료. MQ Watcher를 다시 시작합니다.",
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
    install: "Verify and update",
    cancel: "Cancel",
    release: "Open release",
    installing: "Downloading and verifying SHA-256",
    restarting: "Verified. MQ Watcher is restarting.",
    privacy: "Store paths, names, and analysis results are never sent.",
  },
} as const;

function withValues(value: string, state: UpdateState) {
  return value.replace("{current}", state.currentVersion || "?").replace("{latest}", state.latestVersion || "?");
}

export function UpdatePanel({ locale }: { locale: Locale }) {
  const labels = copy[locale];
  const [state, setState] = useState<UpdateState>({ status: "checking" });
  const [installing, setInstalling] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

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
    void check();
    return () => requestRef.current?.abort();
  }, [check]);

  const install = async () => {
    const controller = new AbortController();
    requestRef.current = controller;
    setInstalling(true);
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install" }),
        signal: controller.signal,
      });
      const body = await response.json() as UpdateState;
      if (!response.ok) throw new Error(body.error?.message || "Update install failed");
      setState(body);
    } catch (error) {
      if (controller.signal.aborted) setState((current) => ({ ...current, status: "update-available" }));
      else setState((current) => ({ ...current, status: "error", error: { message: error instanceof Error ? error.message : String(error) } }));
    } finally {
      setInstalling(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  let message: string = labels.checking;
  if (state.status === "up-to-date") message = labels.currentOk;
  if (state.status === "update-available") message = state.canInstall ? withValues(labels.available, state) : labels.manual;
  if (["blocked-draft", "blocked-prerelease", "blocked-downgrade"].includes(state.status)) message = labels.blocked;
  if (state.status === "manual") message = labels.manual;
  if (state.status === "restarting") message = labels.restarting;
  if (state.status === "error") message = labels.failed;

  return (
    <section className="update-panel" aria-live="polite">
      <div className="update-panel-title"><RefreshCw size={14} /><strong>{labels.title}</strong></div>
      <p>{installing ? labels.installing : message}</p>
      {state.currentVersion && state.latestVersion ? <small>{withValues(labels.current, state)}</small> : null}
      <div className="update-panel-actions">
        {state.status === "checking" ? <LoaderCircle className="spin" size={15} /> : null}
        {state.status === "update-available" && state.canInstall && !installing ? <button onClick={install}><Download size={13} />{labels.install}</button> : null}
        {installing ? <button onClick={() => requestRef.current?.abort()}><X size={13} />{labels.cancel}</button> : null}
        {state.releaseUrl ? <a href={state.releaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{labels.release}</a> : null}
        {state.status === "error" ? <button onClick={check}><RefreshCw size={13} />{labels.check}</button> : null}
      </div>
      <small className="update-privacy">{labels.privacy}</small>
    </section>
  );
}
