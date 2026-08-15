"use client";

import { AlertCircle, ArrowRight, CheckCircle2, FileArchive, MapPin, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import type { MessageTraceEvidence, ScanResult } from "@/app/lib/types";
import { normalizeMessageId, traceMessageEvidence } from "@/app/lib/workbench.mjs";
import { formatOffset } from "@/app/lib/utils";
import { Badge, Button, Card } from "../ui";
import { PageNavigator } from "../PageNavigator";

const PAGE_SIZE = 100;

export function MessageTrace({ current, stores, initialMessageId, initialScope = "current", onSelectEvidence }: { current: ScanResult; stores: ScanResult[]; initialMessageId?: string; initialScope?: "current" | "all"; onSelectEvidence: (storeSignature: string, evidence: MessageTraceEvidence) => void }) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialMessageId ?? "");
  const [submittedId, setSubmittedId] = useState(() => normalizeMessageId(initialMessageId));
  const [scope, setScope] = useState<"current" | "all" | "selected">(initialScope);
  const [selectedStores, setSelectedStores] = useState<string[]>([current.signature]);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const result = useMemo(() => {
    if (!submittedId) return null;
    const scopedStores = scope === "current" ? [current] : scope === "all" ? stores : stores.filter((store) => selectedStores.includes(store.signature));
    return traceMessageEvidence(scopedStores, submittedId);
  }, [scope, current, stores, selectedStores, submittedId]);
  const flattened = result?.storeRefs.flatMap((store) => store.evidence.map((evidence) => ({ store, evidence }))) ?? [];
  const pages = Math.max(1, Math.ceil(flattened.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = flattened.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const grouped = visible.reduce((map, item) => {
    const storeKey = item.store.storeSignature;
    if (!map.has(storeKey)) map.set(storeKey, { store: item.store, journals: new Map<string, MessageTraceEvidence[]>() });
    const journals = map.get(storeKey)!.journals;
    if (!journals.has(item.evidence.sourceFile)) journals.set(item.evidence.sourceFile, []);
    journals.get(item.evidence.sourceFile)!.push(item.evidence);
    return map;
  }, new Map<string, { store: { storeSignature: string; storeName: string }; journals: Map<string, MessageTraceEvidence[]> }>());

  const submit = () => {
    const normalized = normalizeMessageId(input);
    if (!normalized) { setError(t("trace.invalid")); setSubmittedId(""); return; }
    if (scope === "selected" && !selectedStores.length) { setError(t("trace.selectStore")); return; }
    setError(""); setSubmittedId(normalized); setPage(0);
  };

  return <div className="view-stack trace-view">
    <Card className="trace-search-card">
      <div className="section-head"><div><span className="section-kicker">{t("trace.kicker")}</span><h2>{t("trace.title")}</h2></div><Search size={19} /></div>
      <p>{t("trace.description")}</p>
      <label className="trace-input"><span>{t("trace.messageId")}</span><div><input maxLength={512} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} placeholder="ID:..." /><Button onClick={submit}><Search size={14} />{t("trace.action")}</Button></div></label>
      {error ? <div className="trace-error"><AlertCircle size={15} />{error}</div> : null}
      <fieldset className="trace-scope"><legend>{t("trace.scope")}</legend>{(["current", "all", "selected"] as const).map((value) => <label key={value}><input type="radio" name="trace-scope" checked={scope === value} onChange={() => { setScope(value); setPage(0); }} />{t(`trace.scope.${value}`)}</label>)}</fieldset>
      {scope === "selected" ? <div className="trace-store-picker">{stores.map((store) => <label key={store.signature}><input type="checkbox" checked={selectedStores.includes(store.signature)} onChange={() => setSelectedStores((value) => value.includes(store.signature) ? value.filter((signature) => signature !== store.signature) : [...value, store.signature])} /><span>{store.directoryName}</span><code>{store.signature.slice(0, 18)}…</code></label>)}</div> : null}
    </Card>

    {result ? <>
      <Card className="trace-summary"><div><span>{t("trace.result")}</span><h2 title={result.messageId}>{t("trace.resultFor", { id: result.messageId })}</h2></div><div className="trace-metrics"><div><strong>{result.summary.addRecords}</strong><span>{t("trace.add")}</span></div><div><strong>{result.summary.ackRemoveRecords}</strong><span>{t("trace.ack")}</span></div><div><strong>{result.summary.transactionRecords}</strong><span>{t("trace.transactions")}</span></div><div><strong>{result.summary.journalCount}</strong><span>{t("trace.journals")}</span></div><div><strong>{result.summary.snapshotCount}</strong><span>{t("trace.stores")}</span></div></div>{result.summary.addRecords > 1 ? <div className="warning-alert"><ShieldAlert size={15} />{t("trace.repeatedAdd", { count: result.summary.addRecords })} {t("trace.repeatedAddLimit")}</div> : null}<div className="best-effort"><CheckCircle2 size={15} /><span>{result.summary.ackRemoveRecords ? t("trace.ackObserved") : `${t("trace.noAck")} ${t("trace.noAckLimit")}`}</span></div></Card>
      <Card className="trace-questions"><h2>{t("trace.questions")}</h2><ul>{["persisted", "ack", "transaction", "journals", "snapshots"].map((key) => <li key={key}>{t(`trace.question.${key}`)}</li>)}</ul></Card>
      {flattened.length ? <div className="trace-sequence"><div className="section-head"><div><span className="section-kicker">{t("trace.observed")}</span><h2>{t("trace.sequence")}</h2></div><Badge tone="blue">{result.summary.totalEvidence}</Badge></div>{[...grouped.values()].map(({ store, journals }) => <Card className="trace-store" key={store.storeSignature}><div className="trace-store-head"><strong>{store.storeName}</strong><code>{store.storeSignature.slice(0, 24)}…</code></div>{[...journals.entries()].map(([journal, evidence]) => <section key={journal}><h3><FileArchive size={14} />{journal}<small>{t("trace.perJournalOrder")}</small></h3>{evidence.map((item) => <div className="trace-evidence-row" key={item.evidenceRef}><span className="trace-offset">{item.offset === undefined ? "—" : formatOffset(item.offset)}</span><Badge tone={item.evidenceType === "ACK_REMOVE" ? "green" : item.evidenceType === "TRANSACTION" ? "amber" : item.evidenceType === "ADD" ? "blue" : "neutral"}>{t(`trace.type.${item.evidenceType}`)}</Badge><span><strong>{item.destination || t("type.unknown")}</strong><small>{item.transactionId ? `${t("trace.transaction")}: ${item.transactionId}` : t(`confidence.${item.confidence}`)}</small></span><Button variant="secondary" onClick={() => onSelectEvidence(store.storeSignature, item)}><MapPin size={13} />{t("trace.selectForCase")}</Button></div>)}</section>)}</Card>)}</div> : <Card className="trace-empty"><Search size={24} /><h2>{t("trace.none")}</h2><p>{t("trace.noneBody")}</p></Card>}
      {flattened.length > PAGE_SIZE ? <PageNavigator page={safePage} pages={pages} onChange={setPage} /> : null}
      <Card className="trace-limits"><h2>{t("trace.notProve")}</h2><ul>{result.interpretationLimits.map((key) => <li key={key}><ArrowRight size={13} />{t(`trace.limit.${key}`)}</li>)}</ul></Card>
    </> : null}
  </div>;
}
