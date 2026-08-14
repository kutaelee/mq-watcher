"use client";

import { Download, FileCheck2, Info, LoaderCircle, PackageCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import { readIncidentCases } from "@/app/lib/scan-cache";
import type { IncidentCase, ScanResult } from "@/app/lib/types";
import { buildSnapshotDiff } from "@/app/lib/workbench.mjs";
import { Badge, Button, Card } from "../ui";

type SessionOption = { id: string; name: string; result: ScanResult | null };

export function EvidenceExport({ result, sessions }: { result: ScanResult; sessions: SessionOption[] }) {
  const { t, locale } = useI18n();
  const [cases, setCases] = useState<IncidentCase[]>([]);
  const [caseId, setCaseId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [redaction, setRedaction] = useState({ identifiers: true, destinations: false, filePaths: true, notes: false });
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [completed, setCompleted] = useState<{ hash: string; entries: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const operationRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const revokeTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    readIncidentCases().then((values) => { if (mountedRef.current) setCases(values); }).catch(() => undefined);
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      if (workerRef.current) { workerRef.current.onmessage = null; workerRef.current.onerror = null; workerRef.current.terminate(); workerRef.current = null; }
      if (revokeTimerRef.current !== null) window.clearTimeout(revokeTimerRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
  }, []);
  const alternatives = sessions.filter((session) => session.result && session.result.signature !== result.signature);

  const download = async () => {
    const operationId = ++operationRef.current;
    if (workerRef.current) workerRef.current.terminate();
    if (revokeTimerRef.current !== null) window.clearTimeout(revokeTimerRef.current);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setBuilding(true); setProgress(0); setCompleted(null);
    const other = alternatives.find((session) => session.id === compareId)?.result;
    const worker = new Worker("/evidence-export.worker.js", { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ type: string; operationId: number; progress?: number; message?: string; result?: { bytes: Uint8Array; sha256: string; entryNames: string[] } }>) => {
      if (!mountedRef.current || event.data.operationId !== operationRef.current) return;
      if (event.data.type === "progress") setProgress(event.data.progress ?? 0);
      if (event.data.type === "complete" && event.data.result) {
        const blob = new Blob([event.data.result.bytes], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "mq-watcher-evidence-bundle.zip";
        anchor.click();
        revokeTimerRef.current = window.setTimeout(() => { if (objectUrlRef.current === url) { URL.revokeObjectURL(url); objectUrlRef.current = null; } }, 1000);
        setCompleted({ hash: event.data.result.sha256, entries: event.data.result.entryNames.length });
        setBuilding(false); setProgress(100);
        worker.onmessage = null; worker.onerror = null; worker.terminate(); workerRef.current = null;
      }
      if (event.data.type === "cancelled" || event.data.type === "error") {
        setBuilding(false);
        worker.onmessage = null; worker.onerror = null; worker.terminate(); workerRef.current = null;
      }
    };
    worker.onerror = () => { if (operationId === operationRef.current && mountedRef.current) { setBuilding(false); worker.terminate(); workerRef.current = null; } };
    worker.postMessage({ type: "build", operationId, payload: { result, incidentCase: cases.find((item) => item.id === caseId) ?? null, comparison: other ? buildSnapshotDiff(result, other) : [], locale, redaction } });
  };

  const cancel = () => {
    const operationId = operationRef.current;
    workerRef.current?.postMessage({ type: "cancel", operationId });
  };

  return <div className="export-layout">
    <Card className="export-card"><div className="section-head"><div><span className="section-kicker">{t("export.scope")}</span><h2>{t("export.bundle")}</h2></div><PackageCheck size={20} /></div><p>{t("export.bundleBody")}</p><div className="export-files"><div><FileCheck2 size={15} /><span><strong>manifest.json</strong><small>{t("export.manifest")}</small></span></div><div><FileCheck2 size={15} /><span><strong>evidence.json</strong><small>{t("export.evidenceJson")}</small></span></div><div><FileCheck2 size={15} /><span><strong>report.html</strong><small>{t("export.report")}</small></span></div><div><FileCheck2 size={15} /><span><strong>SHA256SUMS.txt</strong><small>{t("export.sums")}</small></span></div></div><div className="best-effort"><Info size={15} /><span>{t("export.noSource")}</span></div></Card>
    <Card className="export-card"><div className="section-head"><div><span className="section-kicker">{t("export.options")}</span><h2>{t("export.include")}</h2></div></div><div className="export-fields"><label htmlFor="export-case"><span>{t("export.case")}</span></label><select id="export-case" aria-label={t("export.case")} value={caseId} onChange={(event) => setCaseId(event.target.value)}><option value="">{t("export.noCase")}</option>{cases.map((item) => <option key={item.id} value={item.id}>{item.title || t("case.untitled")}</option>)}</select><label htmlFor="export-compare"><span>{t("export.comparison")}</span></label><select id="export-compare" aria-label={t("export.comparison")} value={compareId} onChange={(event) => setCompareId(event.target.value)}><option value="">{t("export.noComparison")}</option>{alternatives.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><h3>{t("export.redaction")}</h3><div className="redaction-options">{(["identifiers", "destinations", "filePaths", "notes"] as const).map((key) => { const id = `redact-${key}`; return <label key={key} htmlFor={id}><input id={id} aria-label={t(`export.redact.${key}`)} type="checkbox" checked={redaction[key]} onChange={(event) => setRedaction((current) => ({ ...current, [key]: event.target.checked }))} /><span><strong>{t(`export.redact.${key}`)}</strong><small>{t(`export.redact.${key}.desc`)}</small></span></label>; })}</div>{building ? <div className="export-progress"><span style={{ width: `${progress}%` }} /><strong>{progress}%</strong></div> : null}<div className="export-actions"><Button className="export-button" onClick={download} disabled={building}>{building ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{building ? t("export.building") : t("export.download")}</Button>{building ? <Button variant="secondary" onClick={cancel}>{t("common.cancel")}</Button> : null}</div>{completed ? <div className="export-complete"><PackageCheck size={18} /><div><strong>{t("export.complete", { count: completed.entries })}</strong><code>SHA-256 {completed.hash}</code></div><Badge tone="green">ZIP</Badge></div> : null}</Card>
  </div>;
}
