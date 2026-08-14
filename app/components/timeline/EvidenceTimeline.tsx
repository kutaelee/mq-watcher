"use client";

import { ChevronLeft, ChevronRight, Clock3, Info } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import type { ScanResult } from "@/app/lib/types";
import { buildEvidenceTimeline, MAX_TIMELINE_EVENTS } from "@/app/lib/workbench.mjs";
import { compactId, formatOffset } from "@/app/lib/utils";
import { Badge, Button, Card } from "../ui";

const PAGE_SIZE = 100;

export function EvidenceTimeline({ result }: { result: ScanResult }) {
  const { t } = useI18n();
  const timeline = buildEvidenceTimeline(result);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = timeline.events.filter((event) => (category === "all" || event.category === category) && `${event.command} ${event.destination} ${event.primaryId} ${event.file}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  return <div className="view-stack">
    <Card className="timeline-toolbar"><div className="inline-search"><Clock3 size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder={t("timeline.search")} /></div><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(0); }}><option value="all">{t("timeline.all")}</option><option value="message">{t("timeline.category.message")}</option><option value="transaction">{t("timeline.category.transaction")}</option><option value="subscription">{t("timeline.category.subscription")}</option><option value="record">{t("timeline.category.record")}</option></select><Badge tone="blue">{t("timeline.count", { count: filtered.length })}</Badge></Card>
    <div className="best-effort"><Info size={15} /><span>{t("timeline.orderLimit")}</span></div>
    {timeline.truncated ? <div className="warning-alert"><Info size={15} />{t("timeline.truncated", { shown: MAX_TIMELINE_EVENTS, total: timeline.total })}</div> : null}
    <Card className="timeline-card">{visible.length ? <div className="timeline-list">{visible.map((event, index) => <div key={event.id} className="timeline-event"><div className="timeline-marker"><span>{safePage * PAGE_SIZE + index + 1}</span></div><div className="timeline-content"><div><Badge tone={event.category === "transaction" ? "amber" : event.category === "subscription" ? "violet" : "blue"}>{t(`timeline.category.${event.category}`)}</Badge><strong>{event.command}</strong><Badge tone="neutral">{t(`confidence.${event.confidence}`)}</Badge></div><p>{event.destination} · <code title={event.primaryId}>{compactId(event.primaryId, 28, 12)}</code></p><small>{event.file} · {event.offset === null ? t("type.unknown") : formatOffset(event.offset)} · {t("timeline.status", { status: event.status })}</small></div></div>)}</div> : <p className="compare-no-diff">{t("timeline.empty")}</p>}</Card>
    <div className="timeline-pages"><Button variant="secondary" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}><ChevronLeft size={14} />{t("common.previous")}</Button><span>{safePage + 1} / {pages}</span><Button variant="secondary" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>{t("common.next")}<ChevronRight size={14} /></Button></div>
  </div>;
}
