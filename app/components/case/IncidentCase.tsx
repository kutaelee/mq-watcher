"use client";

import { BookOpen, Lightbulb, MapPin, NotebookPen, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import { deleteIncidentCase, readIncidentCases, writeIncidentCase } from "@/app/lib/scan-cache";
import type { CasePin, IncidentCase as IncidentCaseValue, ScanResult } from "@/app/lib/types";
import { addCaseNote, addCasePin, buildInvestigativeLeads, createIncidentCase, LEAD_THRESHOLDS, removeCaseNote, removeCasePin, resolveCasePin } from "@/app/lib/workbench.mjs";
import { Badge, Button, Card } from "../ui";

type PinCandidate = Omit<CasePin, "pinnedAt">;

export function IncidentCase({ result, pinCandidate, pinCandidates, tutorialCase = null, onTrace }: { result: ScanResult; pinCandidate: PinCandidate | null; pinCandidates: PinCandidate[]; tutorialCase?: IncidentCaseValue | null; onTrace: (messageId: string) => void }) {
  const { t } = useI18n();
  const [cases, setCases] = useState<IncidentCaseValue[]>(() => tutorialCase ? [tutorialCase] : []);
  const [activeId, setActiveId] = useState(() => tutorialCase?.id ?? "");
  const [note, setNote] = useState("");
  const [pinQuery, setPinQuery] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<PinCandidate | null>(pinCandidate);

  useEffect(() => {
    if (tutorialCase) return;
    readIncidentCases(result.signature).then((values) => {
      setCases(values);
      setActiveId(values[0]?.id ?? "");
    }).catch(() => undefined);
  }, [result.signature, tutorialCase]);

  const active = cases.find((item) => item.id === activeId) ?? null;
  const effectiveSelectedCandidate = selectedCandidate ?? pinCandidate;
  const leads = buildInvestigativeLeads(result);
  const persist = (next: IncidentCaseValue) => {
    setCases((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    setActiveId(next.id);
    if (!tutorialCase) writeIncidentCase(next).catch(() => undefined);
  };
  const createCase = () => persist(createIncidentCase(new Date().toISOString(), `case-${Date.now().toString(36)}`, result.signature, result.directoryName));
  const removeCase = async () => {
    if (!active || !window.confirm(t("case.deleteConfirm"))) return;
    const deletingId = active.id;
    const remaining = cases.filter((item) => item.id !== deletingId);
    setCases(remaining);
    setActiveId(remaining[0]?.id ?? "");
    await deleteIncidentCase(deletingId).catch(() => undefined);
  };
  const update = (changes: Partial<IncidentCaseValue>) => {
    if (!active) return;
    persist({ ...active, ...changes, updatedAt: new Date().toISOString() });
  };
  const visibleCandidates = pinCandidates.filter((candidate) => `${candidate.label} ${candidate.semanticKey} ${candidate.provenance.file} ${candidate.kind}`.toLowerCase().includes(pinQuery.toLowerCase())).slice(0, 30);

  return <div className="case-layout">
    <Card className="case-list">
      <div className="case-list-head"><div><span>{t("case.saved")}</span><strong>{t("case.title")}</strong></div><Button onClick={createCase}><Plus size={14} />{t("case.new")}</Button></div>
      {cases.length ? cases.map((item) => <button key={item.id} className={item.id === activeId ? "active" : ""} onClick={() => setActiveId(item.id)}><NotebookPen size={15} /><span><strong>{item.title || t("case.untitled")}</strong><small>{t("case.pinCount", { count: item.pins.length })} · {t("case.noteCount", { count: item.notes.length })}</small></span></button>) : <div className="case-list-empty"><BookOpen size={23} /><p>{t("case.empty")}</p><Button onClick={createCase}>{t("case.new")}</Button></div>}
    </Card>
    <div className="case-main">
      {!active ? <Card className="case-welcome"><NotebookPen size={28} /><h2>{t("case.welcome.title")}</h2><p>{t("case.welcome.body")}</p></Card> : <>
        <Card className="case-editor">
          <div className="case-editor-actions"><Button variant="danger" onClick={removeCase}><Trash2 size={14} />{t("case.delete")}</Button></div>
          <label><span>{t("case.field.title")}</span><input value={active.title} onChange={(event) => update({ title: event.target.value })} placeholder={t("case.field.titlePlaceholder")} /></label>
          <label><span>{t("case.field.hypothesis")}</span><textarea value={active.hypothesis} onChange={(event) => update({ hypothesis: event.target.value })} placeholder={t("case.field.hypothesisPlaceholder")} /></label>
          <div className="case-pin-action"><div><MapPin size={16} /><span><strong>{t("case.pinSelected")}</strong><small>{effectiveSelectedCandidate ? effectiveSelectedCandidate.label : t("case.noSelection")}</small></span></div><span className="case-pin-buttons">{effectiveSelectedCandidate?.semanticKey.startsWith("message:") ? <Button variant="secondary" onClick={() => onTrace(effectiveSelectedCandidate.semanticKey.slice("message:".length))}>{t("trace.action")}</Button> : null}<Button variant="secondary" disabled={!effectiveSelectedCandidate} onClick={() => effectiveSelectedCandidate && persist(addCasePin(active, effectiveSelectedCandidate))}>{t("case.pin")}</Button></span></div>
        </Card>
        <Card className="case-section case-evidence-picker"><div className="section-head"><div><span className="section-kicker">{t("case.evidence")}</span><h2>{t("case.pickEvidence")}</h2></div><MapPin size={18} /></div><p className="case-muted">{t("case.pickEvidenceBody")}</p><div className="case-evidence-search"><Search size={15} /><input value={pinQuery} onChange={(event) => setPinQuery(event.target.value)} placeholder={t("case.pickEvidencePlaceholder")} /></div>{visibleCandidates.length ? <div className="case-evidence-candidates">{visibleCandidates.map((candidate) => { const candidateKey = `${candidate.kind}:${candidate.semanticKey}:${candidate.provenance.file}:${candidate.provenance.offset}`; const isSelected = selectedCandidate && `${selectedCandidate.kind}:${selectedCandidate.semanticKey}:${selectedCandidate.provenance.file}:${selectedCandidate.provenance.offset}` === candidateKey; return <div className={isSelected ? "selected" : ""} key={candidateKey}><button className="case-candidate-select" onClick={() => setSelectedCandidate(candidate)} aria-pressed={Boolean(isSelected)}><Badge tone={isSelected ? "blue" : "neutral"}>{candidate.kind}</Badge><span><strong title={candidate.label}>{candidate.label}</strong><small>{candidate.provenance.file || t("type.unknown")}</small></span></button><Button variant="secondary" onClick={() => { setSelectedCandidate(candidate); persist(addCasePin(active, candidate)); }}><MapPin size={13} />{t("case.pinDirect")}</Button></div>; })}</div> : <p className="case-muted">{t("case.noEvidenceMatch")}</p>}</Card>
        <Card className="case-section"><div className="section-head"><div><span className="section-kicker">{t("case.evidence")}</span><h2>{t("case.pins")}</h2></div><Badge tone="blue">{active.pins.length}</Badge></div>{active.pins.length ? <div className="case-pins">{active.pins.map((pin) => { const resolution = resolveCasePin(pin, [result]); return <div key={`${pin.storeSignature}:${pin.semanticKey}:${pin.provenance.file}:${pin.provenance.offset}`}><MapPin size={14} /><div><strong>{pin.label}</strong><small>{pin.storeName} · {pin.provenance.file || t("type.unknown")}{pin.provenance.offset === null ? "" : ` @ 0x${pin.provenance.offset.toString(16)}`}</small><code>{pin.semanticKey}</code></div>{pin.semanticKey.startsWith("message:") ? <button className="case-pin-trace" onClick={() => onTrace(pin.semanticKey.slice("message:".length))}>{t("trace.action")}</button> : null}<Badge tone={resolution.status === "resolved" ? "green" : "amber"}>{t(`case.reference.${resolution.status}`)}</Badge><button className="case-pin-remove" onClick={() => persist(removeCasePin(active, pin))} aria-label={t("case.removePin")}><Trash2 size={13} /></button></div>; })}</div> : <p className="case-muted">{t("case.noPins")}</p>}</Card>
        <Card className="case-section"><div className="section-head"><div><span className="section-kicker">{t("case.notes")}</span><h2>{t("case.investigationNotes")}</h2></div></div><div className="case-note-entry"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("case.notePlaceholder")} /><Button onClick={() => { const next = addCaseNote(active, note); persist(next); setNote(""); }}>{t("case.addNote")}</Button></div>{active.notes.length ? <div className="case-notes">{active.notes.map((item) => <div key={item.id}><span><p>{item.text}</p><small>{new Date(item.createdAt).toLocaleString()}</small></span><button className="case-pin-remove" onClick={() => persist(removeCaseNote(active, item.id))} aria-label={t("case.removeNote")}><Trash2 size={13} /></button></div>)}</div> : null}</Card>
      </>}
      <Card className="case-section"><div className="section-head"><div><span className="section-kicker">{t("case.leads")}</span><h2>{t("case.leadsTitle")}</h2></div><Lightbulb size={18} /></div><p className="case-muted">{t("case.leadsLimit")}</p><div className="lead-thresholds"><code>{t("case.threshold.advisory", { count: LEAD_THRESHOLDS.advisoryObservations })}</code><code>{t("case.threshold.unknown", { count: LEAD_THRESHOLDS.unknownRecords })}</code><code>{t("case.threshold.journal", { percent: LEAD_THRESHOLDS.journalConcentrationPercent, count: LEAD_THRESHOLDS.journalConcentrationMinimum })}</code></div>{leads.length ? <div className="lead-list">{leads.map((lead) => <div key={lead.code}><Lightbulb size={14} /><span><strong>{t(`case.lead.${lead.code}`)}</strong><small>{t("case.lead.observed", { observed: lead.observed, threshold: lead.threshold })}{lead.detail ? ` · ${lead.detail}` : ""}</small><p><b>{t("case.why")}</b> {t(`case.why.${lead.whyCode}`)}</p><p><b>{t("case.notProve")}</b> {t(`case.notProve.${lead.notProveCode}`)}</p></span></div>)}</div> : <p className="case-muted">{t("case.noLeads")}</p>}</Card>
    </div>
  </div>;
}
